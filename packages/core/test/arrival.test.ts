import { describe, expect, it } from 'vitest';
import { ARRIVAL_SLACK_MS, SnapshotStatus, arrivalMatchNote, arrivalWindowFor, pickArrivalVisit, snapshotSentence } from '../src/index.js';
import { visit } from './repository.contract.js';

// 8–10 AM US Central on a day in daylight time: 13:00Z–15:00Z.
const booked = visit({ id: 'visit_aaaaaaaaaaaaaaaa', windowStart: '2026-10-06T13:00:00.000Z', windowEnd: '2026-10-06T15:00:00.000Z' });

describe('arrival matching (spec §5: a scheduled visit whose window covers the event ±30 min)', () => {
  it('uses a thirty-minute slack', () => {
    expect(ARRIVAL_SLACK_MS).toBe(1_800_000);
    expect(arrivalWindowFor('2026-10-06T13:20:00.000Z')).toEqual({ fromIso: '2026-10-06T12:50:00.000Z', toIso: '2026-10-06T13:50:00.000Z' });
  });

  it('matches exactly at both edges and not one millisecond past either', () => {
    expect(pickArrivalVisit([booked], '2026-10-06T12:30:00.000Z')?.id).toBe('visit_aaaaaaaaaaaaaaaa');
    expect(pickArrivalVisit([booked], '2026-10-06T12:29:59.999Z')).toBeNull();
    expect(pickArrivalVisit([booked], '2026-10-06T15:30:00.000Z')?.id).toBe('visit_aaaaaaaaaaaaaaaa');
    expect(pickArrivalVisit([booked], '2026-10-06T15:30:00.001Z')).toBeNull();
  });

  it('compares instants, so a window booked across the end of daylight time still matches correctly', () => {
    // 2026-11-01 is the US fall-back day. 8–10 AM Central that morning is
    // 14:00Z–16:00Z (standard time), an hour later in UTC than in October.
    const fallBack = visit({ id: 'visit_bbbbbbbbbbbbbbbb', windowStart: '2026-11-01T14:00:00.000Z', windowEnd: '2026-11-01T16:00:00.000Z' });
    expect(pickArrivalVisit([fallBack], '2026-11-01T13:30:00.000Z')?.id).toBe('visit_bbbbbbbbbbbbbbbb'); // 7:30 AM CST
    expect(pickArrivalVisit([fallBack], '2026-11-01T13:29:00.000Z')).toBeNull(); // 7:29 AM CST
  });

  it('takes the visit whose window starts nearest the ring when windows overlap', () => {
    const early = visit({ id: 'visit_cccccccccccccccc', windowStart: '2026-10-06T12:00:00.000Z', windowEnd: '2026-10-06T16:00:00.000Z' });
    const near = visit({ id: 'visit_dddddddddddddddd', windowStart: '2026-10-06T13:30:00.000Z', windowEnd: '2026-10-06T15:30:00.000Z' });
    expect(pickArrivalVisit([early, near], '2026-10-06T13:20:00.000Z')?.id).toBe('visit_dddddddddddddddd');
    expect(pickArrivalVisit([near, early], '2026-10-06T13:20:00.000Z')?.id).toBe('visit_dddddddddddddddd');
  });

  it('breaks an exact tie by the earlier window start', () => {
    const before = visit({ id: 'visit_eeeeeeeeeeeeeeee', windowStart: '2026-10-06T13:10:00.000Z', windowEnd: '2026-10-06T14:00:00.000Z' });
    const after = visit({ id: 'visit_ffffffffffffffff', windowStart: '2026-10-06T13:30:00.000Z', windowEnd: '2026-10-06T14:00:00.000Z' });
    expect(pickArrivalVisit([after, before], '2026-10-06T13:20:00.000Z')?.id).toBe('visit_eeeeeeeeeeeeeeee');
  });

  it('ignores a visit that has already arrived or is not scheduled', () => {
    expect(pickArrivalVisit([{ ...booked, status: 'arrived' }], '2026-10-06T13:20:00.000Z')).toBeNull();
    expect(pickArrivalVisit([{ ...booked, status: 'missed' }], '2026-10-06T13:20:00.000Z')).toBeNull();
  });
});

describe('snapshot sentences (spec §5: every status is a plain sentence; none renders as a blank)', () => {
  it('gives every status its own non-empty sentence', () => {
    const sentences = SnapshotStatus.options.map(snapshotSentence);
    for (const s of sentences) expect(typeof s === 'string' && s.length > 0).toBe(true);
    expect(new Set(sentences).size).toBe(SnapshotStatus.options.length);
  });

  it('says what each outcome means, in words a household reads', () => {
    expect(snapshotSentence('ok')).toBe('Photo from the doorbell at the moment of the ring.');
    expect(snapshotSentence('encrypted')).toBe(
      "The doorbell's video encryption kept the photo private, so there is no picture. The arrival was still recorded."
    );
    expect(snapshotSentence('none-in-window')).toBe('The doorbell had no picture from that moment.');
    expect(snapshotSentence('forbidden')).toBe('Ring did not allow HomeLedger to fetch a photo from that moment.');
    expect(snapshotSentence('error')).toBe('The doorbell photo could not be fetched.');
  });

  it('says nothing before an arrival', () => {
    expect(snapshotSentence(null)).toBeNull();
  });

  it('says the match came from the booking, not from the photo', () => {
    expect(arrivalMatchNote({ windowLabel: 'Tuesday, October 6, 8:00 to 10:00 AM CDT', providerName: 'Kettle Creek Water Heaters' })).toBe(
      'Matches your Tuesday, October 6, 8:00 to 10:00 AM CDT visit from Kettle Creek Water Heaters. HomeLedger matched it by the time of the ring, not by the photo.'
    );
  });
});
