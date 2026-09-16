import { S3Client } from "@aws-sdk/client-s3";

let _r2Client: S3Client | null = null;

export function getR2Client(): S3Client | null {
  if (!process.env.R2_ACCOUNT_ID) return null;
  if (!_r2Client) {
    _r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      // R2 does not support AWS-style payload checksums.
      // "WHEN_REQUIRED" stops the SDK from auto-injecting
      // x-amz-checksum-crc32 / x-amz-sdk-checksum-algorithm into presigned URLs.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return _r2Client;
}

export const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? "hilaq-content";
export const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? "").replace(
  /\/$/,
  "",
);

export function isR2Available(): boolean {
  return (
    !!process.env.R2_ACCOUNT_ID &&
    !!process.env.R2_ACCESS_KEY_ID &&
    !!process.env.R2_SECRET_ACCESS_KEY
  );
}
