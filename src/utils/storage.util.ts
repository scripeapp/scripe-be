import { SupabaseClient } from "@supabase/supabase-js";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { getR2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from "../config/r2";

// Supported image MIME types
const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isBase64Image(value: string): boolean {
  return value.startsWith("data:image/");
}

function parseBase64Image(base64String: string): {
  mimeType: string;
  buffer: Buffer;
  extension: string;
} {
  const matches = base64String.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid base64 image format");

  const mimeType = matches[1];
  const extension = SUPPORTED_IMAGE_TYPES[mimeType];
  if (!extension) {
    throw new Error(
      `Unsupported image type: ${mimeType}. Supported: ${Object.keys(SUPPORTED_IMAGE_TYPES).join(", ")}`,
    );
  }

  return { mimeType, buffer: Buffer.from(matches[2], "base64"), extension };
}

async function uploadBufferToR2(
  buffer: Buffer,
  mimeType: string,
  key: string,
): Promise<string> {
  const r2 = getR2Client();
  if (!r2) throw new Error("R2 storage is not configured");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Uploads a Multer file buffer to R2 and returns its public URL.
 * Use this in controllers and services that receive multipart file uploads.
 */
export async function uploadMulterFileToR2(
  file: Express.Multer.File,
  key: string,
): Promise<string> {
  return uploadBufferToR2(file.buffer, file.mimetype, key);
}

/**
 * Returns true if the URL or path points to R2 storage.
 * R2 paths start with the R2 public domain or use the "stores/" key prefix.
 */
export function isR2Path(urlOrPath: string): boolean {
  if (R2_PUBLIC_URL && urlOrPath.startsWith(R2_PUBLIC_URL)) return true;
  return urlOrPath.startsWith("stores/");
}

/**
 * Extracts the R2 object key from a public URL, or returns the path as-is
 * if it's already a bare key. Returns null if the URL is not an R2 URL.
 */
export function extractR2Key(publicUrl: string): string | null {
  const prefix = `${R2_PUBLIC_URL}/`;
  if (publicUrl.startsWith(prefix)) return publicUrl.slice(prefix.length);
  if (publicUrl.startsWith("stores/")) return publicUrl;
  return null;
}

function extractSupabasePath(
  publicUrl: string,
  bucket: string,
): string | null {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const index = publicUrl.indexOf(marker);
  if (index === -1) return null;
  return publicUrl.slice(index + marker.length);
}

/**
 * Deletes an image from whichever storage system its URL points to.
 * R2 URLs are deleted via the S3 client; legacy Supabase URLs via the Supabase client.
 */
export async function deleteStorageImage(
  supabase: SupabaseClient,
  publicUrl: string,
  supabaseBucket = "stores",
): Promise<void> {
  const r2Key = extractR2Key(publicUrl);
  if (r2Key) {
    const r2 = getR2Client();
    if (r2) {
      await r2.send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: r2Key }),
      );
    }
    return;
  }

  // Legacy Supabase Storage image
  const supabasePath = extractSupabasePath(publicUrl, supabaseBucket);
  if (supabasePath) {
    await supabase.storage.from(supabaseBucket).remove([supabasePath]);
  }
}

/**
 * Uploads a base64-encoded image to R2 and returns its public URL.
 * Key: {storeId}/products/{productId}/{uuid}.{ext}
 */
export async function uploadBase64Image(
  _supabase: SupabaseClient,
  base64String: string,
  storeId: string,
  productId: string,
): Promise<string> {
  const { mimeType, buffer, extension } = parseBase64Image(base64String);
  const key = `${storeId}/products/${productId}/${randomUUID()}.${extension}`;
  return uploadBufferToR2(buffer, mimeType, key);
}

/**
 * Uploads a base64-encoded store appearance image (banner or logo) to R2.
 * Key: {storeId}/appearance/{slot}/{uuid}.{ext}
 */
export async function uploadStoreAppearanceImage(
  _supabase: SupabaseClient,
  base64String: string,
  storeId: string,
  slot: "banner" | "logo",
): Promise<string> {
  const { mimeType, buffer, extension } = parseBase64Image(base64String);
  const key = `${storeId}/appearance/${slot}/${randomUUID()}.${extension}`;
  return uploadBufferToR2(buffer, mimeType, key);
}

/**
 * Processes a product image field.
 * Uploads to R2 if base64; passes existing URLs through unchanged.
 */
export async function processProductImage(
  supabase: SupabaseClient,
  imageValue: string | null | undefined,
  storeId: string,
  productId: string,
): Promise<string | null> {
  if (!imageValue) return null;
  if (isBase64Image(imageValue)) {
    return uploadBase64Image(supabase, imageValue, storeId, productId);
  }
  return imageValue;
}

/**
 * Processes a store appearance image field (banner or logo).
 * Uploads to R2 if base64; passes existing URLs through unchanged.
 */
export async function processStoreAppearanceImage(
  supabase: SupabaseClient,
  imageValue: string | null | undefined,
  storeId: string,
  slot: "banner" | "logo",
): Promise<string | null> {
  if (!imageValue) return null;
  if (isBase64Image(imageValue)) {
    return uploadStoreAppearanceImage(supabase, imageValue, storeId, slot);
  }
  return imageValue;
}

/**
 * Processes an array of product images, uploading any base64 entries to R2.
 */
export async function processProductImages(
  supabase: SupabaseClient,
  images: (string | null | undefined)[],
  storeId: string,
  productId: string,
): Promise<string[]> {
  const results = await Promise.all(
    images.map((img) => processProductImage(supabase, img, storeId, productId)),
  );
  return results.filter((url): url is string => !!url);
}
