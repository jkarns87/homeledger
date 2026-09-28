import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Spec §5: `get_visit` returns a presigned image URL valid for ten minutes. */
export const SNAPSHOT_URL_TTL_SECONDS = 600;

export function createSnapshotPresigner(opts: {
  bucket: string;
  region?: string;
  client?: S3Client;
  sign?: typeof getSignedUrl;
}): (key: string) => Promise<string> {
  const client = opts.client ?? new S3Client({ region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const sign = opts.sign ?? getSignedUrl;
  return key => sign(client, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), { expiresIn: SNAPSHOT_URL_TTL_SECONDS });
}
