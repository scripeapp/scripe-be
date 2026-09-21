/**
 * Database access for the bill, bill line, and bill payment allocation domain belongs
 * here. Repository functions must accept DatabaseContext and must not import the global
 * database.
 */
import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { AllocatePaymentInput, CreateBillInput } from "./payables.types.js";
export async function createBill(c: DatabaseContext, businessId: string, userId: string, input: CreateBillInput): Promise<{ id: string }> { const bill = (await sql<{ id: string }>`insert into app.bills ("businessId","supplierAccountId","billNumber","billType","assetCode","issuedAt","dueAt","subtotalMinor","taxMinor","totalMinor","notes","createdBy") values (${businessId}::uuid,${input.supplierAccountId ?? null}::uuid,${input.billNumber},${input.billType ?? 'supplier'},${input.assetCode ?? 'NGN'},${input.issuedAt ?? null}::date,${input.dueAt ?? null}::date,${input.subtotalMinor},${input.taxMinor ?? 0},${input.totalMinor},${input.notes ?? ''},${userId}::uuid) returning "id"`.execute(c.transaction)).rows[0]!; for (const line of input.lines) await sql`insert into app.bill_lines ("businessId","billId","description","quantity","unitAmountMinor","taxMinor","lineTotalMinor","accountCategory","purchaseOrderId","purchaseOrderLineId","goodsReceiptId") values (${businessId}::uuid,${bill.id}::uuid,${line.description},${line.quantity},${line.unitAmountMinor},${line.taxMinor ?? 0},${line.lineTotalMinor},${line.accountCategory},${line.purchaseOrderId ?? null}::uuid,${line.purchaseOrderLineId ?? null}::uuid,${line.goodsReceiptId ?? null}::uuid)`.execute(c.transaction); return bill; }

export async function findBillForAllocation(c: DatabaseContext, businessId: string, billId: string): Promise<{ id: string; status: string; assetCode: string; amountPaidMinor: string; totalMinor: string } | undefined> {
  const result = await sql<{ id: string; status: string; assetCode: string; amountPaidMinor: string; totalMinor: string }>`
    select "id","status","assetCode","amountPaidMinor"::text,"totalMinor"::text from app.bills where "id" = ${billId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(c.transaction);
  return result.rows[0];
}

export async function allocatePayment(c: DatabaseContext, businessId: string, userId: string, billId: string, input: AllocatePaymentInput, id?: string): Promise<{ id: string } | null> { const result = await sql<{ id: string }>`insert into app.bill_payment_allocations ("id","businessId","billId","paymentReference","amountMinor","assetCode","paidAt","createdBy") select coalesce(${id ?? null}::uuid, gen_random_uuid()), ${businessId}::uuid, b."id", ${input.paymentReference}, ${input.amountMinor}, ${input.assetCode}, coalesce(${input.paidAt ?? null}::timestamptz, now()), ${userId}::uuid from app.bills b where b."id"=${billId}::uuid and b."businessId"=${businessId}::uuid and b."status" <> 'voided' and b."assetCode"=${input.assetCode} and b."amountPaidMinor" + ${input.amountMinor} <= b."totalMinor" returning "id"`.execute(c.transaction); const allocation = result.rows[0]; if (!allocation) return null; await sql`update app.bills set "amountPaidMinor"="amountPaidMinor"+${input.amountMinor}, "status"=case when "amountPaidMinor"+${input.amountMinor} = "totalMinor" then 'paid' else 'partially_paid' end where "id"=${billId}::uuid and "businessId"=${businessId}::uuid`.execute(c.transaction); return allocation; }
