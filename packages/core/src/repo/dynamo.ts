import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { Alert, Appliance, Connection, Device, Doc, Event, Household, LogEntry, MaintenanceItem, TaskTypeValue, Visit } from '../domain/schemas.js';
import { HouseholdSchema } from '../domain/schemas.js';
import { gsi1, gsi2, pk, sk } from './keys.js';
import type { Repository } from './repository.js';

type Item = Record<string, unknown>;

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function strip<T>(item: Item | undefined): T | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, GSI1PK: _g1p, GSI1SK: _g1s, GSI2PK: _g2p, GSI2SK: _g2s, entity: _e, ttl: _ttl, ...rest } = item;
  return rest as T;
}

export function createDynamoRepository(opts: {
  tableName: string;
  householdId: string;
  client?: DynamoDBDocumentClient;
  endpoint?: string;
  region?: string;
}): Repository {
  const doc =
    opts.client ??
    DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1', ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) }),
      {
        marshallOptions: { removeUndefinedValues: true }
      }
    );
  const T = opts.tableName;
  const P = pk(opts.householdId);

  const put = (SK: string, entity: string, body: Item, extra: Item = {}) =>
    doc.send(new PutCommand({ TableName: T, Item: { PK: P, SK, entity, ...body, ...extra } }));

  const get = async <R>(SK: string): Promise<R | null> => {
    const out = await doc.send(new GetCommand({ TableName: T, Key: { PK: P, SK } }));
    return strip<R>(out.Item);
  };

  const queryPrefix = async <R>(prefix: string, opts2: { forward?: boolean; limit?: number } = {}): Promise<R[]> => {
    const out = await doc.send(
      new QueryCommand({
        TableName: T,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': P, ':s': prefix },
        ScanIndexForward: opts2.forward ?? true,
        ...(opts2.limit ? { Limit: opts2.limit } : {})
      })
    );
    return (out.Items ?? []).map(i => strip<R>(i) as R);
  };

  const isConditionFailure = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

  return {
    async getHousehold() {
      return get<Household>(sk.household());
    },
    // Parsed, not just typed: `timezone` is the only field whose validity the
    // compiler cannot check, and a bad zone written here becomes a wrong clock
    // time spoken to a person days later. Throwing at the write is the whole
    // point of the boundary - see HouseholdSchema.
    async putHousehold(h) {
      await put(sk.household(), 'household', HouseholdSchema.parse(h));
    },
    async resetHousehold() {
      const keys: { PK: string; SK: string }[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const out = await doc.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'PK = :p',
            ExpressionAttributeValues: { ':p': P },
            ProjectionExpression: 'PK, SK',
            ExclusiveStartKey
          })
        );
        for (const item of out.Items ?? []) keys.push({ PK: item.PK as string, SK: item.SK as string });
        ExclusiveStartKey = out.LastEvaluatedKey;
      } while (ExclusiveStartKey);

      const BATCH = 25; // BatchWriteItem's per-request limit
      const MAX_ATTEMPTS = 5;
      for (let i = 0; i < keys.length; i += BATCH) {
        const chunk = keys.slice(i, i + BATCH);
        let requests: { DeleteRequest: { Key: { PK: string; SK: string } } }[] = chunk.map(key => ({ DeleteRequest: { Key: key } }));
        let delayMs = 50;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && requests.length > 0; attempt++) {
          const out = await doc.send(new BatchWriteCommand({ RequestItems: { [T]: requests } }));
          requests = (out.UnprocessedItems?.[T] as typeof requests) ?? [];
          if (requests.length === 0) break;
          if (attempt === MAX_ATTEMPTS) break;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          delayMs *= 2;
        }
        if (requests.length > 0) {
          throw new Error(`resetHousehold: ${requests.length} item(s) still unprocessed after ${MAX_ATTEMPTS} attempts`);
        }
      }
    },

    async putAppliance(a) {
      await put(sk.appliance(a.id), 'appliance', a);
    },
    async getAppliance(id) {
      return get<Appliance>(sk.appliance(id));
    },
    async listAppliances(filter) {
      const all = await queryPrefix<Appliance>('APPL#');
      return all
        .filter(a => (filter?.room ? a.room === filter.room : true))
        .filter(a => (filter?.category ? a.category === filter.category : true))
        .sort((x, y) => x.name.localeCompare(y.name));
    },

    async putMaintenance(m) {
      await put(sk.maintenance(m.applianceId, m.taskType), 'maintenance', m, { GSI1PK: gsi1.due(opts.householdId), GSI1SK: m.nextDueAt });
    },
    async getMaintenance(applianceId: string, taskType: TaskTypeValue) {
      return get<MaintenanceItem>(sk.maintenance(applianceId, taskType));
    },
    async listMaintenanceDue(horizonDays, now) {
      const limit = addDays(now.slice(0, 10), horizonDays);
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :p AND GSI1SK <= :d',
          ExpressionAttributeValues: { ':p': gsi1.due(opts.householdId), ':d': limit },
          ScanIndexForward: true
        })
      );
      return (out.Items ?? []).map(i => strip<MaintenanceItem>(i) as MaintenanceItem);
    },

    async appendLog(e) {
      await put(sk.log(e.createdAt, e.id), 'log', e);
    },
    async listLogs(applianceId, limit) {
      const all = await queryPrefix<LogEntry>('LOG#', { forward: false });
      return all.filter(l => l.applianceId === applianceId).slice(0, limit);
    },

    async putDoc(d) {
      await put(sk.doc(d.id), 'doc', d);
    },
    async getDoc(id) {
      return get<Doc>(sk.doc(id));
    },

    async putEvent(e) {
      try {
        await doc.send(
          new PutCommand({
            TableName: T,
            Item: { PK: P, SK: sk.eventMarker(e.ringEventId), entity: 'event_marker', eventId: e.id },
            ConditionExpression: 'attribute_not_exists(PK)'
          })
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'duplicate';
        throw err;
      }
      await put(sk.event(e.at, e.id), 'event', e);
      return 'created';
    },
    async listEvents(sinceIso) {
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'PK = :p AND SK BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':p': P, ':from': `EVENT#${sinceIso}`, ':to': 'EVENT#9999' },
          ScanIndexForward: false
        })
      );
      return (out.Items ?? []).map(i => strip<Event>(i) as Event);
    },

    async putVisit(v) {
      await put(sk.visit(v.id), 'visit', v, { GSI2PK: gsi2.visit(opts.householdId), GSI2SK: v.windowStart });
    },
    async getVisit(id) {
      return get<Visit>(sk.visit(id));
    },
    async listVisitsInWindow(fromIso, toIso) {
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :p AND GSI2SK <= :to',
          FilterExpression: 'windowEnd >= :from',
          ExpressionAttributeValues: { ':p': gsi2.visit(opts.householdId), ':to': toIso, ':from': fromIso },
          ScanIndexForward: true
        })
      );
      return (out.Items ?? []).map(i => strip<Visit>(i) as Visit);
    },
    async listVisitsSince(sinceIso) {
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :p AND GSI2SK >= :s',
          ExpressionAttributeValues: { ':p': gsi2.visit(opts.householdId), ':s': sinceIso },
          ScanIndexForward: true
        })
      );
      return (out.Items ?? []).map(i => strip<Visit>(i) as Visit);
    },

    async putAlert(a) {
      await put(sk.alert(a.id), 'alert', a);
    },
    async listAlerts(sinceIso) {
      const all = await queryPrefix<Alert>('ALERT#');
      return all.filter(a => a.at >= sinceIso).sort((x, y) => y.at.localeCompare(x.at));
    },

    async putDevice(d) {
      await put(sk.device(d.ringDeviceId), 'device', d);
    },
    async listDevices() {
      const all = await queryPrefix<Device>('DEVICE#');
      return all.sort((x, y) => x.name.localeCompare(y.name));
    },
    async getDevice(ringDeviceId) {
      return get<Device>(sk.device(ringDeviceId));
    },
    async claimEvent(e) {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: T,
                  Item: { PK: P, SK: sk.eventMarker(e.ringEventId), entity: 'event_marker', eventId: e.id, published: false },
                  ConditionExpression: 'attribute_not_exists(PK)'
                }
              },
              { Put: { TableName: T, Item: { PK: P, SK: sk.event(e.at, e.id), entity: 'event', ...e } } }
            ]
          })
        );
        return 'new';
      } catch (err) {
        // A transaction whose condition fails is cancelled as a whole and
        // reports TransactionCanceledException, not ConditionalCheckFailedException
        // - but that same exception name also covers TransactionConflict (a
        // concurrent transaction on this same item, i.e. two redeliveries
        // racing each other - exactly the case this method exists for),
        // throttling, and other reasons that have nothing to do with this
        // event already being claimed. CancellationReasons[0] is the marker
        // Put's outcome; only ConditionalCheckFailed there means "already
        // claimed". Anything else - including a TransactionCanceledException
        // with no CancellationReasons - is rethrown unchanged, so the caller
        // (the webhook) answers 500 and Ring retries the whole delivery.
        const cancellation = err as { name?: string; CancellationReasons?: { Code?: string }[] };
        if (cancellation.name !== 'TransactionCanceledException' || cancellation.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed') {
          throw err;
        }
      }
      const marker = await doc.send(new GetCommand({ TableName: T, Key: { PK: P, SK: sk.eventMarker(e.ringEventId) } }));
      if (marker.Item?.published === true) return 'published';
      await put(sk.event(e.at, e.id), 'event', e);
      return 'retry';
    },
    async markEventPublished(ringEventId) {
      await doc.send(
        new UpdateCommand({
          TableName: T,
          Key: { PK: P, SK: sk.eventMarker(ringEventId) },
          UpdateExpression: 'SET published = :t',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':t': true }
        })
      );
    },
    async markVisitArrived(visitId, arrivedAt, ringEventId) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: T,
            Key: { PK: P, SK: sk.visit(visitId) },
            UpdateExpression: 'SET #status = :arrived, arrivedAt = :at, ringEventIds = list_append(if_not_exists(ringEventIds, :empty), :ev)',
            ConditionExpression: 'attribute_exists(PK) AND #status = :scheduled',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':arrived': 'arrived', ':scheduled': 'scheduled', ':at': arrivedAt, ':empty': [], ':ev': [ringEventId] }
          })
        );
        return 'arrived';
      } catch (err) {
        if (isConditionFailure(err)) return 'not-scheduled';
        throw err;
      }
    },
    async recordVisitSnapshot(visitId, snapshot) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: T,
            Key: { PK: P, SK: sk.visit(visitId) },
            UpdateExpression: 'SET snapshotKey = :k, snapshotStatus = :s, description = :d, snapshotLatencyMs = :l',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: {
              ':k': snapshot.snapshotKey,
              ':s': snapshot.snapshotStatus,
              ':d': snapshot.description,
              ':l': snapshot.snapshotLatencyMs
            }
          })
        );
      } catch (err) {
        if (isConditionFailure(err)) throw new Error(`No visit ${visitId}`);
        throw err;
      }
    },
    async findOpenAlert(ringDeviceId, sensorType) {
      const all = await queryPrefix<Alert>('ALERT#');
      return (
        all.filter(a => a.ringDeviceId === ringDeviceId && a.sensorType === sensorType && a.status === 'open').sort((x, y) => y.at.localeCompare(x.at))[0] ??
        null
      );
    },
    async putConnection(c) {
      await put(sk.connection(c.connectionId), 'connection', c, { ttl: c.expiresAt });
    },
    async deleteConnection(connectionId) {
      await doc.send(new DeleteCommand({ TableName: T, Key: { PK: P, SK: sk.connection(connectionId) } }));
    },
    async listConnections(nowEpochSeconds) {
      const all = await queryPrefix<Connection>('CONN#');
      return all.filter(c => c.expiresAt > nowEpochSeconds);
    }
  };
}
