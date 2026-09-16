import { randomUUID } from "crypto";
import {
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  getR2Client,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
  isR2Available,
} from "../config/r2";

const PRESIGN_TTL_SECONDS = 900; // 15 minutes
const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB (soft guard)

const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
]);

export interface PresignParams {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  context: string;
  entityId?: string;
  businessId: string;
  userId: string;
}

export interface PresignResult {
  uploadUrl: string;
  fileKey: string;
  uploadId: string;
  expiresAt: string;
}

export interface ConfirmResult {
  url: string;
}

export class UploadService {
  async presign(
    params: PresignParams,
    supabaseAdmin: SupabaseClient,
  ): Promise<PresignResult> {
    if (!isR2Available()) {
      throw new Error("R2 storage is not configured");
    }

    const {
      fileName,
      mimeType,
      sizeBytes,
      context,
      entityId,
      businessId,
      userId,
    } = params;

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Unsupported file type: ${mimeType}. Allowed: ${Array.from(ALLOWED_MIME_TYPES).join(", ")}`,
      );
    }

    if (sizeBytes > MAX_SIZE_BYTES) {
      throw new Error(
        `File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. Maximum allowed: 500 MB`,
      );
    }

    // Derive extension safely
    const dotIndex = fileName.lastIndexOf(".");
    const ext =
      dotIndex !== -1 ? fileName.slice(dotIndex + 1).toLowerCase() : "bin";
    const fileKey = `${businessId}/${context}/${randomUUID()}.${ext}`;

    const r2 = getR2Client()!;

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileKey,
      ContentType: mimeType, // Must be in the command so the signature covers Content-Type
    });

    const uploadUrl = await getSignedUrl(r2, command, {
      expiresIn: PRESIGN_TTL_SECONDS,
    });
    const expiresAt = new Date(
      Date.now() + PRESIGN_TTL_SECONDS * 1000,
    ).toISOString();

    const { data, error } = await supabaseAdmin
      .from("pending_uploads")
      .insert({
        file_key: fileKey,
        business_id: businessId,
        context,
        entity_id: entityId ?? null,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        uploaded_by: userId,
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (error || !data) {
      // Log the full error so we can distinguish "table not found" from RLS / other issues
      console.error("[UploadService] presign insert error:", JSON.stringify(error));
      const detail = error?.message ?? error?.code ?? "no data returned — table may not exist or RLS blocked the insert";
      throw new Error(`Failed to create upload record: ${detail}`);
    }

    return {
      uploadUrl,
      fileKey,
      uploadId: data.id as string,
      expiresAt,
    };
  }

  async confirm(
    uploadId: string,
    userId: string,
    supabaseAdmin: SupabaseClient,
  ): Promise<ConfirmResult> {
    const { data: row, error } = await supabaseAdmin
      .from("pending_uploads")
      .select("id, file_key, uploaded_by, confirmed_at")
      .eq("id", uploadId)
      .single();

    if (error || !row) {
      throw new Error("Upload record not found");
    }

    if ((row.uploaded_by as string) !== userId) {
      throw new Error("Unauthorized: upload does not belong to this user");
    }

    if (row.confirmed_at) {
      throw new Error("Upload already confirmed");
    }

    const { error: updateError } = await supabaseAdmin
      .from("pending_uploads")
      .update({ confirmed_at: new Date().toISOString() })
      .eq("id", uploadId);

    if (updateError) {
      throw new Error(`Failed to confirm upload: ${updateError.message}`);
    }

    const url = `${R2_PUBLIC_URL}/${row.file_key as string}`;
    return { url };
  }

  async verifyAndMarkProcessed(
    uploadId: string,
    supabaseAdmin: SupabaseClient,
  ): Promise<{ sizeBytes: number }> {
    const { data: row, error } = await supabaseAdmin
      .from("pending_uploads")
      .select("id, file_key")
      .eq("id", uploadId)
      .single();

    if (error || !row) {
      throw new Error("Upload record not found");
    }

    const r2 = getR2Client();
    if (!r2) throw new Error("R2 not configured");

    // Verify the object actually exists in R2 and grab real size
    const headCmd = new HeadObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: row.file_key as string,
    });

    const head = await r2.send(headCmd);
    const sizeBytes = head.ContentLength ?? 0;

    await supabaseAdmin
      .from("pending_uploads")
      .update({
        processed_at: new Date().toISOString(),
        size_bytes: sizeBytes,
      })
      .eq("id", uploadId);

    return { sizeBytes };
  }

  async cleanupOrphans(supabaseAdmin: SupabaseClient): Promise<void> {
    const now = new Date().toISOString();

    const { data: orphans, error } = await supabaseAdmin
      .from("pending_uploads")
      .select("id, file_key")
      .lt("expires_at", now)
      .is("confirmed_at", null);

    if (error) {
      console.error(
        "[UploadService] Failed to query orphaned uploads:",
        error.message,
      );
      return;
    }

    if (!orphans || orphans.length === 0) {
      console.log("[UploadService] No orphaned uploads found");
      return;
    }

    console.log(
      `[UploadService] Cleaning up ${orphans.length} orphaned upload(s)`,
    );

    const r2 = getR2Client();
    let deletedCount = 0;

    for (const orphan of orphans) {
      try {
        if (r2) {
          await r2.send(
            new DeleteObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: orphan.file_key as string,
            }),
          );
        }

        await supabaseAdmin
          .from("pending_uploads")
          .delete()
          .eq("id", orphan.id);
        deletedCount++;
      } catch (err) {
        console.error(
          `[UploadService] Failed to clean up orphan ${orphan.id}:`,
          err,
        );
      }
    }

    console.log(
      `[UploadService] Cleaned up ${deletedCount}/${orphans.length} orphaned upload(s)`,
    );
  }
}

export const uploadService = new UploadService();
