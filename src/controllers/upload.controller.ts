import { Request, Response } from "express";
import { Receiver } from "@upstash/qstash";
import { supabaseAdmin } from "../config/supabaseAdmin";
import ApiResponse from "../utils/apiResponse";
import { uploadService } from "../services/upload.service";
import { queueVideoProcessingJob, isQStashAvailable } from "../config/qstash";
import { isR2Available } from "../config/r2";
import { SupabaseRequest } from "src/types/http";

if (!supabaseAdmin) {
  throw new Error("Supabase Admin not initialized");
}

const db = supabaseAdmin;

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

export class UploadController {
  /**
   * POST /api/upload/presign
   * Returns a short-lived R2 presigned PUT URL + upload record ID
   */
  async presignUpload(req: SupabaseRequest, res: Response): Promise<Response> {
    if (!isR2Available()) {
      return ApiResponse.error(
        res,
        "Video upload is not available at this time. Please use an external video URL instead.",
        503,
      );
    }

    const { fileName, mimeType, sizeBytes, context, entityId, businessId } =
      req.body as {
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        context: string;
        entityId?: string;
        businessId: string;
      };

    try {
      const result = await uploadService.presign(
        {
          fileName,
          mimeType,
          sizeBytes,
          context,
          entityId,
          businessId,
          userId: req.user_id!, // authenticateUser middleware guarantees this is set
        },
        db,
      );

      return ApiResponse.success(res, "Presigned URL created", result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create presigned URL";
      console.error("[UploadController] presignUpload error:", err);
      return ApiResponse.error(res, message, 400);
    }
  }

  /**
   * POST /api/upload/confirm
   * Marks the upload as confirmed and enqueues a QStash processing job
   */
  async confirmUpload(req: SupabaseRequest, res: Response): Promise<Response> {
    const { uploadId } = req.body as { uploadId: string };

    try {
      const { url } = await uploadService.confirm(uploadId, req.user_id!, db); // authenticateUser guarantees user_id

      // Fire-and-forget QStash job — non-fatal if unavailable
      let processingJobId: string | null = null;
      if (isQStashAvailable()) {
        try {
          const { data: row } = await db
            .from("pending_uploads")
            .select("file_key, mime_type, business_id, context")
            .eq("id", uploadId)
            .single();

          if (row) {
            processingJobId = await queueVideoProcessingJob({
              uploadId,
              fileKey: row.file_key as string,
              mimeType: row.mime_type as string,
              businessId: row.business_id as string,
              context: row.context as string,
            });

            if (processingJobId) {
              await db
                .from("pending_uploads")
                .update({ processing_job_id: processingJobId })
                .eq("id", uploadId);
            }
          }
        } catch (qErr) {
          console.error(
            "[UploadController] Failed to enqueue video processing job:",
            qErr,
          );
        }
      }

      return ApiResponse.success(res, "Upload confirmed", {
        url,
        ...(processingJobId ? { processingJobId } : {}),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to confirm upload";
      console.error("[UploadController] confirmUpload error:", err);
      return ApiResponse.error(res, message, 400);
    }
  }

  /**
   * POST /api/upload/process-video
   * QStash callback — verifies signature inline, runs HeadObject on R2, marks processed_at
   */
  async processVideo(req: Request, res: Response): Promise<Response> {
    if (process.env.NODE_ENV === "production") {
      const signature = req.headers["upstash-signature"] as string | undefined;

      if (!signature) {
        console.error("[UploadController] processVideo: missing signature");
        return ApiResponse.error(res, "Unauthorized", 401);
      }

      try {
        const isValid = await receiver.verify({
          signature,
          body: JSON.stringify(req.body),
        });

        if (!isValid) {
          console.error("[UploadController] processVideo: invalid signature");
          return ApiResponse.error(res, "Unauthorized", 401);
        }
      } catch (err) {
        console.error(
          "[UploadController] processVideo: signature verification error:",
          err,
        );
        return ApiResponse.error(res, "Unauthorized", 401);
      }
    }

    const { uploadId } = req.body as { uploadId?: string };

    if (!uploadId) {
      return ApiResponse.badRequest(res, "uploadId is required");
    }

    try {
      const { sizeBytes } = await uploadService.verifyAndMarkProcessed(
        uploadId,
        db,
      );
      console.log(
        `[UploadController] processVideo: verified uploadId=${uploadId}, size=${sizeBytes} bytes`,
      );
      return ApiResponse.success(res, "Video processed", {
        uploadId,
        sizeBytes,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to process video";
      console.error("[UploadController] processVideo error:", err);
      return ApiResponse.error(res, message, 500);
    }
  }
}

export const uploadController = new UploadController();
