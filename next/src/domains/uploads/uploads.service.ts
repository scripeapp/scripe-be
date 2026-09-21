import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { objectStorage } from "../../integrations/r2.js";
import { AppError, conflictError, notFoundError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./uploads.repository.js";
import type { CreateUploadInput, CreateUploadResult, Upload, UploadRow, UploadWithDownloadUrl, UploadsOperation } from "./uploads.types.js";

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

/** A confirmed object's actual size differing this much from the declared size fails confirmation — accounts for encoding/metadata slack, not a spoofed file. */
const SIZE_MISMATCH_TOLERANCE_BYTES = 16;

export class UploadsService {
  constructor(private readonly database: Database) {}

  async create(operation: UploadsOperation, input: CreateUploadInput): Promise<CreateUploadResult> {
    return this.run(operation, async (context) => {
      if (input.businessId) await requirePermission(context, input.businessId, "upload.manage");

      const objectKey = `uploads/${input.purpose}/${randomUUID()}${EXTENSION_BY_MIME_TYPE[input.mimeType] ?? ""}`;
      const created = await repository.createUpload(context, operation.userId, objectKey, input);
      const presigned = await objectStorage.createPresignedUploadUrl(objectKey, input.mimeType, Number(input.sizeBytes));

      return {
        upload: toUpload(created),
        uploadUrl: presigned.uploadUrl,
        uploadUrlExpiresAt: presigned.expiresAt.toISOString(),
      };
    });
  }

  async confirm(operation: UploadsOperation, uploadId: string): Promise<Upload> {
    // Marking the upload failed must survive even though this method then throws:
    // withDatabaseContext runs `work` inside a single transaction, so a throw from
    // within it rolls back everything the callback did, including the failure write.
    // Detect the outcome inside one transaction, then commit the failure separately.
    const outcome = await this.run(operation, async (context) => {
      const upload = await this.requireAccessible(context, operation, uploadId);
      if (upload.status !== "pending") throw conflictError(`Upload is already ${upload.status}`);

      const metadata = await objectStorage.headObject(upload.objectKey);
      if (!metadata.exists) {
        return { failed: true as const, reason: "The object was not found in storage. Upload it before confirming." };
      }
      const actualSize = metadata.sizeBytes ?? 0;
      if (Math.abs(actualSize - Number(upload.sizeBytes)) > SIZE_MISMATCH_TOLERANCE_BYTES) {
        return { failed: true as const, reason: "The uploaded object's size does not match what was declared." };
      }

      return { failed: false as const, upload: toUpload(await repository.markConfirmed(context, uploadId, actualSize.toString())) };
    });

    if (outcome.failed) {
      await this.run(operation, (context) => repository.markFailed(context, uploadId));
      throw conflictError(outcome.reason);
    }
    return outcome.upload;
  }

  async get(operation: UploadsOperation, uploadId: string): Promise<UploadWithDownloadUrl> {
    return this.run(operation, async (context) => {
      const upload = await this.requireAccessible(context, operation, uploadId);
      const downloadUrl = upload.status === "confirmed" ? await objectStorage.createPresignedDownloadUrl(upload.objectKey) : null;
      return { ...toUpload(upload), downloadUrl };
    });
  }

  async listForBusiness(operation: UploadsOperation, businessId: string, purpose?: string): Promise<Upload[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, businessId, "upload.manage");
      return (await repository.listForBusiness(context, businessId, purpose)).map(toUpload);
    });
  }

  async listForSelf(operation: UploadsOperation, purpose?: string): Promise<Upload[]> {
    return this.run(operation, async (context) => (await repository.listForUser(context, operation.userId, purpose)).map(toUpload));
  }

  async remove(operation: UploadsOperation, uploadId: string): Promise<void> {
    return this.run(operation, async (context) => {
      const upload = await this.requireAccessible(context, operation, uploadId);
      if (upload.status === "deleted") return;
      await objectStorage.deleteObject(upload.objectKey);
      await repository.markDeleted(context, uploadId);
    });
  }

  private async requireAccessible(context: DatabaseContext, operation: UploadsOperation, uploadId: string): Promise<UploadRow> {
    const upload = await repository.findAccessible(context, operation.userId, uploadId);
    if (!upload) throw notFoundError("Upload not found");
    if (upload.businessId) await requirePermission(context, upload.businessId, "upload.manage");
    else if (upload.userId !== operation.userId) throw notFoundError("Upload not found");
    return upload;
  }

  private async run<T>(operation: UploadsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toUpload(row: UploadRow): Upload {
  return {
    ...row,
    retentionUntil: row.retentionUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
