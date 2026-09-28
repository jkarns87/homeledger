import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export type PutSnapshot = (key: string, bytes: Buffer, contentType: string) => Promise<void>;

/** Byte-for-byte: Ring's watermark is mandatory, so the image is never re-encoded (spec §5). */
export function createSnapshotWriter(bucket: string, client: S3Client = new S3Client({})): PutSnapshot {
  return async (key, bytes, contentType) => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
  };
}

export function snapshotKeyFor(householdId: string, visitId: string, kind: 'jpeg' | 'png'): string {
  return `snapshots/${householdId}/${visitId}.${kind === 'png' ? 'png' : 'jpg'}`;
}
