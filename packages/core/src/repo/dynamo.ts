import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Alert, Appliance, Device, Doc, Event, Household, LogEntry, MaintenanceItem, TaskTypeValue, Visit } from '../domain/schemas.js';
import { gsi1, gsi2, pk, sk } from './keys.js';
import type { Repository } from './repository.js';

type Item = Record<string, unknown>;

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function strip<T>(item: Item | undefined): T | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, GSI1PK: _g1p, GSI1SK: _g1s, GSI2PK: _g2p, GSI2SK: _g2s, entity: _e, ...rest } = item;
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

  return {
    async getHousehold() {
      return get<Household>(sk.household());
    },
    async putHousehold(h) {
      await put(sk.household(), 'household', h);
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
            Item: { PK: P, SK: `EVENTID#${e.ringEventId}`, entity: 'event_marker', eventId: e.id },
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
    }
  };
}
