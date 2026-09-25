import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadEnvironment } from "../shared/environment.js";
import { serviceUnavailableError } from "../shared/errors.js";

const UPLOAD_URL_TTL_SECONDS = 600;
const DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 300;

export interface PresignedUpload {
  readonly uploadUrl: string;
  readonly expiresAt: Date;
}

export interface ObjectMetadata {
  readonly exists: boolean;
  readonly sizeBytes?: number;
  readonly contentType?: string;
  readonly etag?: string;
}

/**
 * Private-bucket object storage: the backend issues short-lived presigned
 * URLs rather than exposing a public bucket URL (rules.md E). Implemented
 * against Cloudflare R2's S3-compatible API.
 */
export interface ObjectStorage {
  createPresignedUploadUrl(key: string, contentType: string, contentLength: number): Promise<PresignedUpload>;
  createPresignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  headObject(key: string): Promise<ObjectMetadata>;
  deleteObject(key: string): Promise<void>;
  /** Server-side read, used only to forward a stored document to a provider that takes file uploads (e.g. Anchor KYB). */
  getObjectBytes(key: string): Promise<Uint8Array>;
}

class R2ObjectStorage implements ObjectStorage {
  private resolved: { client: S3Client; bucket: string } | undefined;

  /** Throws SERVICE_UNAVAILABLE rather than pretending storage works when R2 isn't configured — no route in this domain silently no-ops. */
  private resolve(): { client: S3Client; bucket: string } {
    if (this.resolved) return this.resolved;
    const environment = loadEnvironment();
    if (!environment.R2_ACCOUNT_ID || !environment.R2_ACCESS_KEY_ID || !environment.R2_SECRET_ACCESS_KEY || !environment.R2_BUCKET_NAME) {
      throw serviceUnavailableError("Object storage is not configured (missing R2 credentials).");
    }
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: environment.R2_ACCESS_KEY_ID,
        secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
      },
    });
    this.resolved = { client, bucket: environment.R2_BUCKET_NAME };
    return this.resolved;
  }

  async createPresignedUploadUrl(key: string, contentType: string, contentLength: number): Promise<PresignedUpload> {
    const { client, bucket } = this.resolve();
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return { uploadUrl, expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000) };
  }

  async createPresignedDownloadUrl(key: string, expiresInSeconds = DEFAULT_DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    const { client, bucket } = this.resolve();
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    const { client, bucket } = this.resolve();
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { exists: true, sizeBytes: result.ContentLength, contentType: result.ContentType, etag: result.ETag };
    } catch (error) {
      if (isNotFound(error)) return { exists: false };
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const { client, bucket } = this.resolve();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async getObjectBytes(key: string): Promise<Uint8Array> {
    const { client, bucket } = this.resolve();
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error(`Object ${key} has no body`);
    return result.Body.transformToByteArray();
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const withMetadata = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return withMetadata.name === "NotFound" || withMetadata.$metadata?.httpStatusCode === 404;
}

export const objectStorage: ObjectStorage = new R2ObjectStorage();
