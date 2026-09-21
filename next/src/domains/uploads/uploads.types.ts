export type UploadPurpose = "product_image" | "compliance_document" | "avatar" | "other";
export type UploadStatus = "pending" | "confirmed" | "failed" | "deleted";

export interface UploadRow {
  readonly id: string;
  readonly businessId: string | null;
  readonly userId: string;
  readonly purpose: UploadPurpose;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly checksum: string | null;
  readonly status: UploadStatus;
  readonly retentionUntil: Date | null;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface Upload extends Omit<UploadRow, "retentionUntil" | "createdAt" | "confirmedAt" | "deletedAt"> {
  readonly retentionUntil: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly deletedAt: string | null;
}

export interface UploadsOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface CreateUploadInput {
  readonly businessId?: string | null;
  readonly purpose: UploadPurpose;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly checksum?: string | null;
}

export interface CreateUploadResult {
  readonly upload: Upload;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: string;
}

export interface UploadWithDownloadUrl extends Upload {
  readonly downloadUrl: string | null;
}
