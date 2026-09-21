import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { CreateUploadInput, UploadRow } from "./uploads.types.js";

const UPLOAD_COLUMNS = sql`
  "id", "businessId", "userId", "purpose", "objectKey", "mimeType", "sizeBytes"::text, "checksum",
  "status", "retentionUntil", "createdAt", "confirmedAt", "deletedAt"
`;

export async function createUpload(context: DatabaseContext, userId: string, objectKey: string, input: CreateUploadInput): Promise<UploadRow> {
  const result = await sql<UploadRow>`
    insert into app.uploads ("businessId", "userId", "purpose", "objectKey", "mimeType", "sizeBytes", "checksum")
    values (${input.businessId ?? null}::uuid, ${userId}::uuid, ${input.purpose}, ${objectKey}, ${input.mimeType}, ${input.sizeBytes}::bigint, ${input.checksum ?? null})
    returning ${UPLOAD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

/** Scoped by ownership: a personal upload (businessId null) must belong to userId; a business upload's authorization is enforced by RLS via requirePermission before this is called. */
export async function findAccessible(context: DatabaseContext, userId: string, uploadId: string): Promise<UploadRow | undefined> {
  const result = await sql<UploadRow>`
    select ${UPLOAD_COLUMNS} from app.uploads
    where "id" = ${uploadId}::uuid and ("businessId" is not null or "userId" = ${userId}::uuid)
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listForBusiness(context: DatabaseContext, businessId: string, purpose?: string): Promise<UploadRow[]> {
  const purposeClause = purpose ? sql`and "purpose" = ${purpose}` : sql``;
  const result = await sql<UploadRow>`
    select ${UPLOAD_COLUMNS} from app.uploads
    where "businessId" = ${businessId}::uuid and "status" <> 'deleted' ${purposeClause}
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function listForUser(context: DatabaseContext, userId: string, purpose?: string): Promise<UploadRow[]> {
  const purposeClause = purpose ? sql`and "purpose" = ${purpose}` : sql``;
  const result = await sql<UploadRow>`
    select ${UPLOAD_COLUMNS} from app.uploads
    where "userId" = ${userId}::uuid and "businessId" is null and "status" <> 'deleted' ${purposeClause}
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function markConfirmed(context: DatabaseContext, uploadId: string, sizeBytes: string): Promise<UploadRow> {
  const result = await sql<UploadRow>`
    update app.uploads set "status" = 'confirmed', "confirmedAt" = now(), "sizeBytes" = ${sizeBytes}::bigint
    where "id" = ${uploadId}::uuid
    returning ${UPLOAD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function markFailed(context: DatabaseContext, uploadId: string): Promise<UploadRow> {
  const result = await sql<UploadRow>`
    update app.uploads set "status" = 'failed'
    where "id" = ${uploadId}::uuid
    returning ${UPLOAD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function markDeleted(context: DatabaseContext, uploadId: string): Promise<UploadRow> {
  const result = await sql<UploadRow>`
    update app.uploads set "status" = 'deleted', "deletedAt" = now()
    where "id" = ${uploadId}::uuid
    returning ${UPLOAD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}
