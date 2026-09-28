import { describe, expect, it } from 'vitest';
import type { ImageAnswer } from '../src/ring/client.js';
import { SNAPSHOT_BACKOFF_MS, SNAPSHOT_BUDGET_MS, fetchDoorbellSnapshot, imageKind } from '../src/ring/snapshot.js';
import { JPEG_BYTES, OPAQUE_BYTES, PNG_BYTES, clock } from './fakes.js';

const EVENT = 1791292800000; // 2026-10-06T13:20:00Z

function scripted(answers: Array<ImageAnswer | Error>) {
  const windows: Array<{ startMs: number; endMs: number }> = [];
  let i = 0;
  const requestImage = async (_id: string, window: { startMs: number; endMs: number }): Promise<ImageAnswer> => {
    windows.push(window);
    const next = answers[Math.min(i++, answers.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { requestImage, windows };
}
const image = (bytes: Buffer, contentType = 'image/jpeg'): ImageAnswer => ({ kind: 'image', bytes, contentType });
const refused = (status: number, code: string | null = null): ImageAnswer => ({ kind: 'refused', status, code });

describe('imageKind', () => {
  it('recognises JPEG and PNG by their magic bytes and nothing else', () => {
    expect([imageKind(JPEG_BYTES), imageKind(PNG_BYTES), imageKind(OPAQUE_BYTES), imageKind(Buffer.alloc(0))]).toEqual(['jpeg', 'png', null, null]);
  });
});

describe('fetchDoorbellSnapshot (spec §5 and amendment §12.5)', () => {
  it('stores the first image, and measures latency from the ring to the moment the image was in hand', async () => {
    const c = clock(EVENT + 2_000);
    const s = scripted([image(JPEG_BYTES)]);
    const r = await fetchDoorbellSnapshot({ requestImage: s.requestImage, now: c.now, sleep: c.sleep }, { deviceId: 'dev-doorbell-1', eventAtMs: EVENT });
    expect(r).toEqual({ status: 'ok', bytes: JPEG_BYTES, contentType: 'image/jpeg', latencyMs: 2_000, attempts: 1, lastRefusal: null });
    expect(s.windows[0]).toEqual({ startMs: EVENT - 5_000, endMs: EVENT + 2_000 });
  });

  it('waits out "recording not ready" with growing gaps, and widens the window up to thirty seconds after the ring', async () => {
    const c = clock(EVENT + 2_000);
    const s = scripted([refused(425, 'RECORDING_NOT_READY'), refused(416, 'MEDIA_NOT_FOUND'), image(PNG_BYTES, 'image/png')]);
    const r = await fetchDoorbellSnapshot({ requestImage: s.requestImage, now: c.now, sleep: c.sleep }, { deviceId: 'dev-doorbell-1', eventAtMs: EVENT });
    expect([r.status, r.attempts, r.latencyMs, r.contentType]).toEqual(['ok', 3, 5_000, 'image/png']);
    expect(c.slept).toEqual([1_000, 2_000]);
    expect(s.windows.map(w => w.endMs)).toEqual([EVENT + 2_000, EVENT + 3_000, EVENT + 5_000]);
  });

  it('never asks for a window ending more than thirty seconds after the ring', async () => {
    const c = clock(EVENT + 45_000);
    const s = scripted([image(JPEG_BYTES)]);
    await fetchDoorbellSnapshot({ requestImage: s.requestImage, now: c.now, sleep: c.sleep }, { deviceId: 'dev-doorbell-1', eventAtMs: EVENT });
    expect(s.windows[0]).toEqual({ startMs: EVENT - 5_000, endMs: EVENT + 30_000 });
  });

  it('calls bytes that are not an image encrypted (R4: Unverified), without retrying', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot(
      { ...scripted([image(OPAQUE_BYTES, 'application/octet-stream')]), now: c.now, sleep: c.sleep },
      { deviceId: 'd', eventAtMs: EVENT }
    );
    expect([r.status, r.bytes, r.attempts]).toEqual(['encrypted', null, 1]);
  });

  it('stops at once on 403, which no amount of waiting fixes', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot(
      { ...scripted([refused(403, 'TIME_RANGE_NOT_AUTHORIZED')]), now: c.now, sleep: c.sleep },
      { deviceId: 'd', eventAtMs: EVENT }
    );
    expect([r.status, r.attempts, r.lastRefusal]).toEqual(['forbidden', 1, '403 TIME_RANGE_NOT_AUTHORIZED']);
    expect(c.slept).toEqual([]);
  });

  it('gives up with none-in-window after spending the whole budget on "no media"', async () => {
    expect(SNAPSHOT_BUDGET_MS).toBe(60_000);
    expect([...SNAPSHOT_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(416, 'MEDIA_NOT_FOUND')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.attempts, r.latencyMs]).toEqual(['none-in-window', 8, 60_000]);
    expect(c.slept).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  it('reports error when the budget runs out on server or network failures', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot(
      { ...scripted([refused(503, 'SERVER_BUSY'), new Error('socket hang up')]), now: c.now, sleep: c.sleep },
      { deviceId: 'd', eventAtMs: EVENT }
    );
    expect([r.status, r.lastRefusal]).toEqual(['error', 'network: socket hang up']);
  });

  it('lets the last transient answer decide: server trouble that ends in "no media" is none-in-window', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(503), refused(416)]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect(r.status).toBe('none-in-window');
  });

  it('does not retry a request Ring called malformed', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(400, 'INVALID_PAYLOAD')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.attempts]).toEqual(['error', 1]);
  });
});
