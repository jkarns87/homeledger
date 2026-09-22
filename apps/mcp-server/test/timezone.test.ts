import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRepository, seedRepository } from '@homeledger/core';
import { FALLBACK_TIME_ZONE, memoiseTimeZone, resolveHouseholdTimeZone } from '../src/deps.js';
import { hasJson, speakZonedClock, speakZonedDay, speakZonedInstant, speakZonedWindow } from '../src/voice.js';
import { availabilityWindows } from '../src/tools/service.js';
import { TODAY, modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

const WINDOW_START = '2026-09-15T13:00:00.000Z';
const WINDOW_END = '2026-09-15T15:00:00.000Z';

/** A scheduled visit at the fixed 13:00-15:00Z window, so every test below renders the SAME instant through a different zone. */
async function putWindowVisit(repo: Awaited<ReturnType<typeof modernClient>>['deps']['repo'], id: string, applianceId: string) {
  await repo.putVisit({
    id,
    providerId: 'prov_kettle_water',
    providerName: 'Kettle Creek Water Heaters',
    category: 'water_heater',
    applianceId,
    issue: 'no hot water',
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    status: 'scheduled',
    ringEventIds: [],
    snapshotKey: null,
    description: null,
    arrivedAt: null,
    createdAt: `${TODAY}T12:00:00.000Z`
  });
}

describe('zoned rendering helpers', () => {
  it('renders one instant differently in each zone, and never as the raw UTC clock', () => {
    // The load-bearing assertion of this whole feature. 13:00Z is 1:00 PM in
    // UTC and nothing else, so a renderer that ignored its `zone` argument -
    // hard-coding 'UTC', reading the machine's zone, slicing the ISO string -
    // would produce the SAME output for all three of these. They differ, and
    // each differs from the UTC reading, which is what says the argument is
    // actually applied.
    expect(speakZonedClock(WINDOW_START, 'America/Chicago')).toBe('8:00 AM CDT');
    expect(speakZonedClock(WINDOW_START, 'Asia/Tokyo')).toBe('10:00 PM GMT+9');
    expect(speakZonedClock(WINDOW_START, 'Europe/London')).toBe('2:00 PM GMT+1');
    expect(speakZonedClock(WINDOW_START, 'UTC')).toBe('1:00 PM UTC');
  });

  it('follows the zone across its own daylight-saving change, which a stored offset could not', () => {
    // Same zone, same clock time, six weeks apart across the US DST change.
    // A household stored as "-05:00" would render the November instant an
    // hour wrong; the NAME gets both right, and the abbreviation moves with
    // it. This is the concrete reason the field is a name.
    expect(speakZonedClock('2026-09-15T18:00:00.000Z', 'America/Chicago')).toBe('1:00 PM CDT');
    expect(speakZonedClock('2026-11-15T18:00:00.000Z', 'America/Chicago')).toBe('12:00 PM CST');
  });

  it('names the day the instant falls on in the zone, not the UTC date', () => {
    // 02:00Z on the 16th is still the evening of the 15th in Chicago.
    expect(speakZonedDay('2026-09-16T02:00:00.000Z', 'America/Chicago')).toBe('Tuesday, September 15');
    expect(speakZonedDay('2026-09-16T02:00:00.000Z', 'UTC')).toBe('Wednesday, September 16');
  });

  it('speaks a window as one sentence, and repeats the day only when the window crosses midnight', () => {
    expect(speakZonedWindow(WINDOW_START, WINDOW_END, 'America/Chicago')).toBe('Tuesday, September 15, 8:00 AM to 10:00 AM CDT');
    expect(speakZonedWindow('2026-09-17T04:00:00.000Z', '2026-09-17T06:00:00.000Z', 'America/Chicago')).toBe(
      'Wednesday, September 16, 11:00 PM to Thursday, September 17, 1:00 AM CDT'
    );
  });

  it('speaks a single instant with its day and zone', () => {
    expect(speakZonedInstant('2026-09-15T13:07:00.000Z', 'America/Chicago')).toBe('Tuesday, September 15, 8:07 AM CDT');
  });

  it('ignores the machine the tests happen to be running on', () => {
    // The hazard this guards: an assertion of "1:00 PM" passes on a UTC CI
    // runner and fails on a laptop in Chicago, so the suite starts encoding
    // the runner's clock instead of the household's. `Intl` with an explicit
    // `timeZone` is independent of `process.env.TZ`; this proves it for the
    // wrapper rather than assuming it, by moving the process clock to the
    // far side of the world and expecting no change at all.
    const original = process.env.TZ;
    try {
      for (const machineZone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
        process.env.TZ = machineZone;
        expect(speakZonedWindow(WINDOW_START, WINDOW_END, 'America/Chicago')).toBe('Tuesday, September 15, 8:00 AM to 10:00 AM CDT');
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('carries no JSON punctuation into spoken text', () => {
    // The voice-first contract (spec 4.1) is enforced by the smoke script's
    // `assertSpokenProse` and the per-tool `hasJson` checks. A zone whose
    // abbreviation is an offset ("GMT+9") is still prose; a formatter that
    // ever emitted brackets would not be.
    for (const zone of ['America/Chicago', 'Asia/Tokyo', 'UTC']) expect(hasJson(speakZonedWindow(WINDOW_START, WINDOW_END, zone))).toBe(false);
  });
});

describe('availabilityWindows', () => {
  it('keeps the UTC instants fixed and moves only the label', () => {
    const central = availabilityWindows(`${TODAY}T12:00:00.000Z`, 'America/Chicago');
    const tokyo = availabilityWindows(`${TODAY}T12:00:00.000Z`, 'Asia/Tokyo');
    expect(central.map(w => w.start)).toEqual(tokyo.map(w => w.start));
    expect(central.map(w => w.end)).toEqual(tokyo.map(w => w.end));
    expect(central[0]?.start).toBe(WINDOW_START);
    expect(central[0]?.end).toBe(WINDOW_END);
    expect(central[0]?.label).toBe('Tuesday, September 15, 8:00 AM to 10:00 AM CDT');
    expect(tokyo[0]?.label).toBe('Tuesday, September 15, 10:00 PM to Wednesday, September 16, 12:00 AM GMT+9');
  });
});

describe('resolveHouseholdTimeZone', () => {
  it('returns the seeded household zone', async () => {
    const repo = createMemoryRepository('hh_test');
    await seedRepository(repo, 'hh_test', TODAY);
    expect(await resolveHouseholdTimeZone(repo)).toBe('America/Chicago');
  });

  it('falls back to UTC when no household has been seeded', async () => {
    expect(await resolveHouseholdTimeZone(createMemoryRepository('hh_test'))).toBe(FALLBACK_TIME_ZONE);
  });

  it('falls back to UTC for a row whose timezone is missing or unusable', async () => {
    // Rows written before this field existed, or edited in the DynamoDB
    // console, bypass `putHousehold`'s schema entirely - which is exactly the
    // state the deployed demo table is in until `seed:remote` runs again. The
    // server must still answer, and must render in a zone it can NAME.
    const repo = createMemoryRepository('hh_test');
    const household = { id: 'hh_test', name: 'The Harlow household' } as unknown as Parameters<typeof repo.putHousehold>[0];
    await repo.putHousehold({ ...household, timezone: 'America/Chicago' });
    // Reach past putHousehold the way a stale table row does.
    Object.assign((await repo.getHousehold())!, { timezone: undefined });
    expect(await resolveHouseholdTimeZone(repo)).toBe(FALLBACK_TIME_ZONE);

    Object.assign((await repo.getHousehold())!, { timezone: '-05:00' });
    expect(await resolveHouseholdTimeZone(repo)).toBe(FALLBACK_TIME_ZONE);
  });
});

describe('memoiseTimeZone', () => {
  it('loads once and reuses the answer', async () => {
    let calls = 0;
    const zone = memoiseTimeZone(async () => {
      calls++;
      return 'America/Chicago';
    });
    expect(await Promise.all([zone(), zone(), zone()])).toEqual(['America/Chicago', 'America/Chicago', 'America/Chicago']);
    expect(calls).toBe(1);
  });

  it('does not cache a failure, so one bad read cannot pin the wrong answer for the life of the process', async () => {
    let calls = 0;
    const zone = memoiseTimeZone(async () => {
      calls++;
      if (calls === 1) throw new Error('DynamoDB said no');
      return 'America/Chicago';
    });
    await expect(zone()).rejects.toThrow('DynamoDB said no');
    expect(await zone()).toBe('America/Chicago');
    expect(calls).toBe(2);
  });
});

describe('the household zone reaches every surface that speaks a time', () => {
  it('re-renders get_visit and book_service when the household moves zone', async () => {
    // Nothing about the visit changes here - the stored instants are
    // identical. Only the household record's zone changes, and every
    // human-facing rendering follows it. A surface still wired to UTC, to the
    // machine clock, or to `windowStart.slice(0, 10)` keeps its old string
    // and fails.
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await putWindowVisit(h.deps.repo, 'visit_eeeeeeeeeeeeeeee', appliance.id);

    const central = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_eeeeeeeeeeeeeeee' } });
    expect((central.content as Array<{ text?: string }>)[0]?.text).toContain('8:00 AM to 10:00 AM CDT');
    expect((central.structuredContent as { visit: { windowLabel: string } }).visit.windowLabel).toBe('Tuesday, September 15, 8:00 AM to 10:00 AM CDT');

    await h.deps.repo.putHousehold({ id: 'hh_test', name: 'The Harlow household', timezone: 'Asia/Tokyo' });

    const tokyo = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_eeeeeeeeeeeeeeee' } });
    expect((tokyo.content as Array<{ text?: string }>)[0]?.text).toContain('10:00 PM to Wednesday, September 16, 12:00 AM GMT+9');
    expect((tokyo.structuredContent as { visit: { windowStart: string; windowLabel: string } }).visit).toMatchObject({
      windowStart: WINDOW_START,
      windowLabel: 'Tuesday, September 15, 10:00 PM to Wednesday, September 16, 12:00 AM GMT+9'
    });
  });

  it('speaks recent_events in the household zone', async () => {
    const h = await modernClient();
    close = h.close;
    await h.deps.repo.putEvent({
      id: 'evt_aaaaaaaaaaaaaaaa',
      ringEventId: 'r1',
      type: 'button_press',
      subType: null,
      deviceId: 'd1',
      deviceName: 'Front Door',
      at: `${TODAY}T11:30:00.000Z`,
      rawS3Key: null
    });
    const r = await h.client.callTool({ name: 'recent_events', arguments: {} });
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    // 11:30Z is 6:30 AM Central. "11:30 AM" would be the UTC reading.
    expect(text).toBe('1 event: Someone rang the Front Door at 6:30 AM CDT.');
    expect(hasJson(text)).toBe(false);
    // The structured row keeps the stored UTC instant untouched.
    expect((r.structuredContent as { events: Array<{ at: string }> }).events[0]?.at).toBe(`${TODAY}T11:30:00.000Z`);
  });

  it('computes "today" for maintenance from the household zone, not from UTC', async () => {
    // 02:00Z on the 13th is 9 PM on the 12th in Chicago. A task due on the
    // 12th is therefore still DUE TODAY in that kitchen while UTC's calendar
    // has already called it yesterday's. Both households below are asked the
    // same question at the same instant about the same row and get opposite
    // answers - which is only possible if the zone is read. Swap
    // `todayInZone` back for `deps.now().slice(0, 10)` and the Central case
    // goes overdue, failing here.
    const dueOnTheTwelfth = async (timezone: string) => {
      const h = await modernClient({ now: () => '2026-09-13T02:00:00.000Z' });
      await h.deps.repo.putHousehold({ id: 'hh_test', name: 'The Harlow household', timezone });
      const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
      await h.deps.repo.putMaintenance({
        applianceId: appliance.id,
        taskType: 'flush',
        intervalDays: 365,
        lastDoneAt: '2025-09-12',
        nextDueAt: '2026-09-12',
        notes: null
      });
      const r = await h.client.callTool({ name: 'maintenance_due', arguments: {} });
      const row = (r.structuredContent as { items: Array<{ taskType: string; nextDueAt: string; overdue: boolean }> }).items.find(
        i => i.taskType === 'flush' && i.nextDueAt === '2026-09-12'
      );
      const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
      await h.close();
      return { row, spoken };
    };

    const central = await dueOnTheTwelfth('America/Chicago');
    expect(central.row?.overdue).toBe(false);
    expect(central.spoken).toContain('flush, due September 12');

    const utc = await dueOnTheTwelfth('UTC');
    expect(utc.row?.overdue).toBe(true);
    expect(utc.spoken).toContain('flush, overdue since September 12');
  });
});

describe('the visit widget', () => {
  it('shows the server-rendered label rather than formatting an instant itself', async () => {
    // A widget that called `toLocaleString` would use the VIEWER's clock, so
    // the kitchen display and a phone abroad would disagree about when the
    // plumber arrives. The frame is asserted to contain no formatting call
    // and to read the label the server computed.
    const { VISIT_WIDGET_HTML } = await import('../src/widgets/visit.js');
    expect(VISIT_WIDGET_HTML).toContain('visit.windowLabel');
    expect(VISIT_WIDGET_HTML).toContain('visit.arrivedAtLabel');
    expect(VISIT_WIDGET_HTML).not.toContain('toLocaleString');
    expect(VISIT_WIDGET_HTML).not.toContain('toLocaleTimeString');
    expect(VISIT_WIDGET_HTML).not.toContain('Intl.');
    // The two raw ISO fields it used to print side by side are gone from the
    // rendered card.
    expect(VISIT_WIDGET_HTML).not.toContain("visit.windowStart + ' to ' + visit.windowEnd");
  });
});
