import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_URL_TTL_SECONDS, createSnapshotPresigner } from '../src/snapshots.js';

describe('snapshot presigner (spec §5: a presigned URL valid for ten minutes)', () => {
  it('signs a GET of exactly the stored key for six hundred seconds', async () => {
    const sign = vi.fn(async () => 'https://signed.example/x');
    const client = new S3Client({ region: 'us-east-1' });
    const presign = createSnapshotPresigner({ bucket: 'demo-homeledger-snapshots-123456789012', client, sign: sign as never });
    expect(await presign('snapshots/hh_harlow/visit_abcdefghijklmnop.jpg')).toBe('https://signed.example/x');
    expect(SNAPSHOT_URL_TTL_SECONDS).toBe(600);
    const [usedClient, command, options] = sign.mock.calls[0] as unknown as [S3Client, GetObjectCommand, { expiresIn: number }];
    expect(usedClient).toBe(client);
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'demo-homeledger-snapshots-123456789012', Key: 'snapshots/hh_harlow/visit_abcdefghijklmnop.jpg' });
    expect(options).toEqual({ expiresIn: 600 });
  });

  it('produces URLs on the bucket’s regional origin — the one Terraform declares for the widget (R8)', async () => {
    // Offline: presigning is local computation over static credentials.
    const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret-not-real' } });
    const url = new URL(
      await createSnapshotPresigner({ bucket: 'demo-homeledger-snapshots-123456789012', client })('snapshots/hh_harlow/visit_abcdefghijklmnop.jpg')
    );
    expect(url.origin).toBe('https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  });
});
