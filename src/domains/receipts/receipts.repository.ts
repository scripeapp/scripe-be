import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { FiscalDocumentRow } from "./receipts.types.js";

export interface OrderSnapshot {
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
}

/**
 * Issues the next sequential receipt number for a business and inserts the
 * immutable document, all within the caller's transaction. Locks the
 * business row first so two concurrent orders can never be assigned the same
 * sequence — a plain `for update` on fiscal_documents would lock nothing on
 * a business's very first document.
 */
export async function issueReceipt(
  context: DatabaseContext,
  businessId: string,
  orderId: string,
  userId: string,
  order: OrderSnapshot,
): Promise<FiscalDocumentRow> {
  await sql`select "id" from app.businesses where "id" = ${businessId}::uuid for update`.execute(context.transaction);

  const next = await sql<{ next: string }>`
    select coalesce(max("sequence"), 0) + 1 as "next" from app.fiscal_documents where "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  const sequence = next.rows[0]!.next;
  const number = `RCT-${sequence.padStart(6, "0")}`;

  const result = await sql<FiscalDocumentRow>`
    insert into app.fiscal_documents (
      "businessId", "orderId", "kind", "sequence", "number", "currency",
      "subtotalMinor", "taxMinor", "totalMinor", "createdBy"
    ) values (
      ${businessId}::uuid, ${orderId}::uuid, 'receipt', ${sequence}::bigint, ${number}, ${order.currency},
      ${order.subtotalMinor}::bigint, ${order.taxMinor}::bigint, ${order.totalMinor}::bigint, ${userId}::uuid
    )
    returning "id", "businessId", "orderId", "kind", "sequence"::text, "number", "currency",
      "subtotalMinor"::text, "taxMinor"::text, "totalMinor"::text, "issuedAt", "createdBy"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function findForOrder(context: DatabaseContext, businessId: string, orderId: string): Promise<FiscalDocumentRow | undefined> {
  const result = await sql<FiscalDocumentRow>`
    select "id", "businessId", "orderId", "kind", "sequence"::text, "number", "currency",
      "subtotalMinor"::text, "taxMinor"::text, "totalMinor"::text, "issuedAt", "createdBy"
    from app.fiscal_documents where "businessId" = ${businessId}::uuid and "orderId" = ${orderId}::uuid
    order by "issuedAt" desc limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findById(context: DatabaseContext, businessId: string, documentId: string): Promise<FiscalDocumentRow | undefined> {
  const result = await sql<FiscalDocumentRow>`
    select "id", "businessId", "orderId", "kind", "sequence"::text, "number", "currency",
      "subtotalMinor"::text, "taxMinor"::text, "totalMinor"::text, "issuedAt", "createdBy"
    from app.fiscal_documents where "businessId" = ${businessId}::uuid and "id" = ${documentId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function list(context: DatabaseContext, businessId: string, limit = 50): Promise<FiscalDocumentRow[]> {
  const result = await sql<FiscalDocumentRow>`
    select "id", "businessId", "orderId", "kind", "sequence"::text, "number", "currency",
      "subtotalMinor"::text, "taxMinor"::text, "totalMinor"::text, "issuedAt", "createdBy"
    from app.fiscal_documents where "businessId" = ${businessId}::uuid
    order by "issuedAt" desc, "id" desc limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}
