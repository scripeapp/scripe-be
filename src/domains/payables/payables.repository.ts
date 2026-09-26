/**
 * Database access for the bill, bill line, and bill payment allocation domain belongs
 * here. Repository functions must accept DatabaseContext and must not import the global
 * database.
 */
import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  AllocatePaymentInput,
  BillLineRow,
  BillMetricsResult,
  BillPaymentAllocationRow,
  BillRow,
  CreateBillInput,
  ListBillsFilter,
  UpdateBillInput,
} from "./payables.types.js";

export async function createBill(c: DatabaseContext, businessId: string, userId: string, input: CreateBillInput): Promise<{ id: string }> {
  const bill = (await sql<{ id: string }>`insert into app.bills ("businessId","supplierAccountId","billNumber","billType","assetCode","issuedAt","dueAt","subtotalMinor","taxMinor","totalMinor","notes","createdBy") values (${businessId}::uuid,${input.supplierAccountId ?? null}::uuid,${input.billNumber},${input.billType ?? 'supplier'},${input.assetCode ?? 'NGN'},${input.issuedAt ?? null}::date,${input.dueAt ?? null}::date,${input.subtotalMinor},${input.taxMinor ?? 0},${input.totalMinor},${input.notes ?? ''},${userId}::uuid) returning "id"`.execute(c.transaction)).rows[0]!;
  for (const line of input.lines) {
    await sql`insert into app.bill_lines ("businessId","billId","description","quantity","unitAmountMinor","taxMinor","lineTotalMinor","accountCategory","purchaseOrderId","purchaseOrderLineId","goodsReceiptId") values (${businessId}::uuid,${bill.id}::uuid,${line.description},${line.quantity},${line.unitAmountMinor},${line.taxMinor ?? 0},${line.lineTotalMinor},${line.accountCategory},${line.purchaseOrderId ?? null}::uuid,${line.purchaseOrderLineId ?? null}::uuid,${line.goodsReceiptId ?? null}::uuid)`.execute(c.transaction);
  }
  return bill;
}

export async function findBillForAllocation(c: DatabaseContext, businessId: string, billId: string): Promise<{ id: string; status: string; assetCode: string; amountPaidMinor: string; totalMinor: string } | undefined> {
  const result = await sql<{ id: string; status: string; assetCode: string; amountPaidMinor: string; totalMinor: string }>`
    select "id","status","assetCode","amountPaidMinor"::text,"totalMinor"::text from app.bills where "id" = ${billId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(c.transaction);
  return result.rows[0];
}

export async function allocatePayment(c: DatabaseContext, businessId: string, userId: string, billId: string, input: AllocatePaymentInput, id?: string): Promise<{ id: string } | null> {
  const result = await sql<{ id: string }>`insert into app.bill_payment_allocations ("id","businessId","billId","paymentReference","amountMinor","assetCode","paidAt","createdBy") select coalesce(${id ?? null}::uuid, gen_random_uuid()), ${businessId}::uuid, b."id", ${input.paymentReference}, ${input.amountMinor}, ${input.assetCode}, coalesce(${input.paidAt ?? null}::timestamptz, now()), ${userId}::uuid from app.bills b where b."id"=${billId}::uuid and b."businessId"=${businessId}::uuid and b."status" <> 'voided' and b."assetCode"=${input.assetCode} and b."amountPaidMinor" + ${input.amountMinor} <= b."totalMinor" returning "id"`.execute(c.transaction);
  const allocation = result.rows[0];
  if (!allocation) return null;
  await sql`update app.bills set "amountPaidMinor"="amountPaidMinor"+${input.amountMinor}, "status"=case when "amountPaidMinor"+${input.amountMinor} = "totalMinor" then 'paid' else 'partially_paid' end where "id"=${billId}::uuid and "businessId"=${businessId}::uuid`.execute(c.transaction);
  return allocation;
}

export async function listBills(c: DatabaseContext, businessId: string, f: ListBillsFilter): Promise<{ bills: BillRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`b."businessId" = ${businessId}::uuid`];
  if (f.status) clauses.push(sql`b."status" = ${f.status}`);
  if (f.supplierAccountId) clauses.push(sql`b."supplierAccountId" = ${f.supplierAccountId}::uuid`);
  if (f.search) clauses.push(sql`(b."billNumber" ilike ${`%${f.search}%`} or sp."displayName" ilike ${`%${f.search}%`})`);

  const whereClause = sql.join(clauses, sql` and `);
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const countResult = await sql<{ count: string }>`
    select count(*)::text as "count"
    from app.bills b
    left join app.supplier_accounts s on s."id" = b."supplierAccountId" and s."businessId" = b."businessId"
    left join app.parties sp on sp."id" = s."partyId" and sp."businessId" = s."businessId"
    where ${whereClause}
  `.execute(c.transaction);
  const total = Number(countResult.rows[0]?.count ?? 0);

  const billsResult = await sql<BillRow>`
    select
      b."id",
      b."businessId",
      b."supplierAccountId",
      b."billNumber",
      b."billType",
      b."status",
      b."assetCode",
      b."issuedAt"::text as "issuedAt",
      b."dueAt"::text as "dueAt",
      b."subtotalMinor"::text as "subtotalMinor",
      b."taxMinor"::text as "taxMinor",
      b."totalMinor"::text as "totalMinor",
      b."amountPaidMinor"::text as "amountPaidMinor",
      b."notes",
      b."createdBy",
      b."createdAt"::text as "createdAt",
      b."updatedAt"::text as "updatedAt",
      sp."displayName" as "supplierName",
      coalesce((
        select count(*)::int
        from app.bill_lines bl
        where bl."billId" = b."id" and bl."businessId" = b."businessId"
      ), 0) as "itemsCount"
    from app.bills b
    left join app.supplier_accounts s on s."id" = b."supplierAccountId" and s."businessId" = b."businessId"
    left join app.parties sp on sp."id" = s."partyId" and sp."businessId" = s."businessId"
    where ${whereClause}
    order by b."createdAt" desc
    limit ${pageSize} offset ${offset}
  `.execute(c.transaction);

  return { bills: billsResult.rows, total };
}

export async function findBillById(c: DatabaseContext, businessId: string, billId: string): Promise<BillRow | undefined> {
  const result = await sql<BillRow>`
    select
      b."id",
      b."businessId",
      b."supplierAccountId",
      b."billNumber",
      b."billType",
      b."status",
      b."assetCode",
      b."issuedAt"::text as "issuedAt",
      b."dueAt"::text as "dueAt",
      b."subtotalMinor"::text as "subtotalMinor",
      b."taxMinor"::text as "taxMinor",
      b."totalMinor"::text as "totalMinor",
      b."amountPaidMinor"::text as "amountPaidMinor",
      b."notes",
      b."createdBy",
      b."createdAt"::text as "createdAt",
      b."updatedAt"::text as "updatedAt",
      sp."displayName" as "supplierName",
      coalesce((
        select count(*)::int
        from app.bill_lines bl
        where bl."billId" = b."id" and bl."businessId" = b."businessId"
      ), 0) as "itemsCount"
    from app.bills b
    left join app.supplier_accounts s on s."id" = b."supplierAccountId" and s."businessId" = b."businessId"
    left join app.parties sp on sp."id" = s."partyId" and sp."businessId" = s."businessId"
    where b."id" = ${billId}::uuid and b."businessId" = ${businessId}::uuid
    limit 1
  `.execute(c.transaction);
  return result.rows[0];
}

export async function listBillLines(c: DatabaseContext, businessId: string, billId: string): Promise<BillLineRow[]> {
  const result = await sql<BillLineRow>`
    select
      "id",
      "businessId",
      "billId",
      "description",
      "quantity"::text as "quantity",
      "unitAmountMinor"::text as "unitAmountMinor",
      "taxMinor"::text as "taxMinor",
      "lineTotalMinor"::text as "lineTotalMinor",
      "accountCategory",
      "purchaseOrderId",
      "purchaseOrderLineId",
      "goodsReceiptId",
      "createdAt"::text as "createdAt"
    from app.bill_lines
    where "billId" = ${billId}::uuid and "businessId" = ${businessId}::uuid
    order by "createdAt" asc
  `.execute(c.transaction);
  return result.rows;
}

export async function listBillAllocations(c: DatabaseContext, businessId: string, billId: string): Promise<BillPaymentAllocationRow[]> {
  const result = await sql<BillPaymentAllocationRow>`
    select
      "id",
      "businessId",
      "billId",
      "paymentReference",
      "amountMinor"::text as "amountMinor",
      "assetCode",
      "paidAt"::text as "paidAt",
      "createdBy",
      "createdAt"::text as "createdAt"
    from app.bill_payment_allocations
    where "billId" = ${billId}::uuid and "businessId" = ${businessId}::uuid
    order by "paidAt" desc
  `.execute(c.transaction);
  return result.rows;
}

export async function getBillMetrics(c: DatabaseContext, businessId: string): Promise<BillMetricsResult> {
  const billsSummary = await sql<{
    outstandingMinor: string | null;
    outstandingCount: string;
    dueThisWeekMinor: string | null;
    dueThisWeekCount: string;
    overdueMinor: string | null;
    overdueCount: string;
  }>`
    select
      coalesce(sum("totalMinor" - "amountPaidMinor") filter (where "status" in ('approved', 'partially_paid')), 0)::text as "outstandingMinor",
      count(*) filter (where "status" in ('approved', 'partially_paid'))::text as "outstandingCount",
      coalesce(sum("totalMinor" - "amountPaidMinor") filter (where "status" in ('approved', 'partially_paid') and "dueAt" is not null and "dueAt" <= current_date + interval '7 days'), 0)::text as "dueThisWeekMinor",
      count(*) filter (where "status" in ('approved', 'partially_paid') and "dueAt" is not null and "dueAt" <= current_date + interval '7 days')::text as "dueThisWeekCount",
      coalesce(sum("totalMinor" - "amountPaidMinor") filter (where "status" in ('approved', 'partially_paid') and "dueAt" is not null and "dueAt" < current_date), 0)::text as "overdueMinor",
      count(*) filter (where "status" in ('approved', 'partially_paid') and "dueAt" is not null and "dueAt" < current_date)::text as "overdueCount"
    from app.bills
    where "businessId" = ${businessId}::uuid
  `.execute(c.transaction);

  const paymentsSummary = await sql<{
    paidThisMonthMinor: string | null;
    paidThisMonthCount: string;
  }>`
    select
      coalesce(sum("amountMinor"), 0)::text as "paidThisMonthMinor",
      count(*)::text as "paidThisMonthCount"
    from app.bill_payment_allocations
    where "businessId" = ${businessId}::uuid
      and "paidAt" >= date_trunc('month', now())
  `.execute(c.transaction);

  const b = billsSummary.rows[0];
  const p = paymentsSummary.rows[0];

  return {
    outstandingMinor: b?.outstandingMinor ?? "0",
    outstandingCount: Number(b?.outstandingCount ?? 0),
    dueThisWeekMinor: b?.dueThisWeekMinor ?? "0",
    dueThisWeekCount: Number(b?.dueThisWeekCount ?? 0),
    overdueMinor: b?.overdueMinor ?? "0",
    overdueCount: Number(b?.overdueCount ?? 0),
    paidThisMonthMinor: p?.paidThisMonthMinor ?? "0",
    paidThisMonthCount: Number(p?.paidThisMonthCount ?? 0),
  };
}

export async function updateBill(c: DatabaseContext, businessId: string, billId: string, input: UpdateBillInput): Promise<BillRow | undefined> {
  const updates: RawBuilder<unknown>[] = [];
  if (input.status !== undefined) updates.push(sql`"status" = ${input.status}`);
  if (input.dueAt !== undefined) updates.push(sql`"dueAt" = ${input.dueAt}::date`);
  if (input.notes !== undefined) updates.push(sql`"notes" = ${input.notes}`);

  if (updates.length === 0) return findBillById(c, businessId, billId);

  await sql`
    update app.bills
    set ${sql.join(updates, sql`, `)}
    where "id" = ${billId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(c.transaction);

  return findBillById(c, businessId, billId);
}

export async function deleteBill(c: DatabaseContext, businessId: string, billId: string): Promise<boolean> {
  const bill = await findBillById(c, businessId, billId);
  if (!bill) return false;

  if (bill.status === "draft") {
    await sql`delete from app.bill_lines where "billId" = ${billId}::uuid and "businessId" = ${businessId}::uuid`.execute(c.transaction);
    await sql`delete from app.bills where "id" = ${billId}::uuid and "businessId" = ${businessId}::uuid`.execute(c.transaction);
    return true;
  }

  // Non-draft bills: mark voided if no payments made
  if (BigInt(bill.amountPaidMinor) === 0n) {
    await sql`update app.bills set "status" = 'voided' where "id" = ${billId}::uuid and "businessId" = ${businessId}::uuid`.execute(c.transaction);
    return true;
  }

  throw new Error("Cannot delete a bill with payment allocations");
}
