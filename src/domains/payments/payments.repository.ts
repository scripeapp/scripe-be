import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { ListPaymentsFilter, PaymentRow, RecordPaymentInput } from "./payments.types.js";

export interface OrderSnapshot {
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
}

export interface RecordedPayment {
  readonly id: string;
  /** True whenever this call actually allocated a captured payment against the order (whether or not it was the allocation that reached fully paid) - distinct from isFullyPaid, which only tells you about the order's overall state. */
  readonly captured: boolean;
  /** True only on the call whose amount first brings the order to fully paid. */
  readonly isFullyPaid: boolean;
  readonly order: OrderSnapshot;
}

export async function record(c: DatabaseContext, businessId: string, userId: string, input: RecordPaymentInput): Promise<RecordedPayment> {
  const existing = (await sql<{ id: string }>`select "id" from app.payments where "businessId"=${businessId}::uuid and "idempotencyKey"=${input.idempotencyKey}`.execute(c.transaction)).rows[0];
  if (existing) return { id: existing.id, captured: false, isFullyPaid: false, order: { currency: input.assetCode, subtotalMinor: "0", taxMinor: "0", totalMinor: "0" } };

  const order = (await sql<{ id: string; subtotalMinor: string; taxMinor: string; totalMinor: string; currency: string }>`
    select "id","subtotalMinor","taxMinor","totalMinor","currency" from app.orders where "id"=${input.orderId}::uuid and "businessId"=${businessId}::uuid for update
  `.execute(c.transaction)).rows[0];
  if (!order || order.currency !== input.assetCode) throw new Error("Order is missing or payment currency differs");

  const allocated = (await sql<{ total: string }>`select coalesce(sum("amountMinor"),0)::text total from app.payment_allocations where "businessId"=${businessId}::uuid and "orderId"=${input.orderId}::uuid`.execute(c.transaction)).rows[0]?.total ?? "0";
  if (BigInt(allocated) + BigInt(input.amountMinor) > BigInt(order.totalMinor)) throw new Error("Payment exceeds order balance");

  const payment = (await sql<{ id: string }>`
    insert into app.payments ("businessId","orderId","method","status","assetCode","amountMinor","externalReference","idempotencyKey","createdBy")
    values (${businessId}::uuid,${input.orderId}::uuid,${input.method},${input.status ?? "captured"},${input.assetCode},${input.amountMinor},${input.externalReference ?? null},${input.idempotencyKey},${userId}::uuid)
    returning "id"
  `.execute(c.transaction)).rows[0]!;

  const captured = input.status === undefined || input.status === "captured";
  let isFullyPaid = false;
  if (captured) {
    isFullyPaid = await allocate(c, businessId, input.orderId, payment.id, input.amountMinor, allocated, order.totalMinor);
  }

  return { id: payment.id, captured, isFullyPaid, order: { currency: order.currency, subtotalMinor: order.subtotalMinor, taxMinor: order.taxMinor, totalMinor: order.totalMinor } };
}

/** Shared by record() (status "captured") and captureCheckoutPayment() (an online checkout verified successful) — inserts the allocation and updates the order's paymentStatus. Returns whether this allocation brought the order to fully paid. */
async function allocate(c: DatabaseContext, businessId: string, orderId: string, paymentId: string, amountMinor: string | number, previouslyAllocated: string, totalMinor: string): Promise<boolean> {
  await sql`insert into app.payment_allocations ("businessId","paymentId","orderId","amountMinor") values (${businessId}::uuid,${paymentId}::uuid,${orderId}::uuid,${amountMinor})`.execute(c.transaction);
  const next = BigInt(previouslyAllocated) + BigInt(amountMinor);
  const isFullyPaid = next >= BigInt(totalMinor);
  await sql`update app.orders set "paymentStatus"=case when ${next.toString()}::bigint >= "totalMinor" then 'paid' else 'partially_paid' end where "id"=${orderId}::uuid and "businessId"=${businessId}::uuid`.execute(c.transaction);
  return isFullyPaid;
}

export interface PendingPayment {
  readonly id: string;
  readonly orderId: string;
  readonly amountMinor: string;
  readonly status: "pending" | "authorized" | "captured" | "failed" | "cancelled" | "refunded";
}

export async function findPaymentByExternalReference(c: DatabaseContext, businessId: string, externalReference: string): Promise<PendingPayment | undefined> {
  const result = await sql<PendingPayment>`
    select "id","orderId","amountMinor","status" from app.payments where "businessId"=${businessId}::uuid and "externalReference"=${externalReference}
  `.execute(c.transaction);
  return result.rows[0];
}

export async function createAttempt(c: DatabaseContext, businessId: string, paymentId: string, provider: string, providerReference: string): Promise<void> {
  await sql`
    insert into app.payment_attempts ("businessId","paymentId","provider","status","providerReference")
    values (${businessId}::uuid,${paymentId}::uuid,${provider},'initiated',${providerReference})
  `.execute(c.transaction);
}

export async function findAttemptByReference(c: DatabaseContext, businessId: string, providerReference: string): Promise<{ provider: string; status: string } | undefined> {
  const result = await sql<{ provider: string; status: string }>`
    select "provider","status" from app.payment_attempts where "businessId"=${businessId}::uuid and "providerReference"=${providerReference}
  `.execute(c.transaction);
  return result.rows[0];
}

export async function markAttempt(c: DatabaseContext, businessId: string, providerReference: string, status: "authorized" | "captured" | "failed" | "cancelled", failureReason: string | null): Promise<void> {
  await sql`
    update app.payment_attempts set "status"=${status}, "failureReason"=${failureReason}
    where "businessId"=${businessId}::uuid and "providerReference"=${providerReference}
  `.execute(c.transaction);
}

/**
 * Captures a payment left "pending" by initiateCheckout() once the gateway
 * confirms it actually succeeded. Idempotent: re-verifying an
 * already-captured payment just returns the current order snapshot without
 * re-allocating (a second webhook/verify call must never double-count).
 */
export async function captureCheckoutPayment(c: DatabaseContext, businessId: string, paymentId: string): Promise<{ captured: boolean; isFullyPaid: boolean; amountMinor: string; method: string; order: OrderSnapshot } | undefined> {
  const payment = (await sql<{ orderId: string; amountMinor: string; status: string; method: string }>`
    select "orderId","amountMinor","status","method" from app.payments where "id"=${paymentId}::uuid and "businessId"=${businessId}::uuid for update
  `.execute(c.transaction)).rows[0];
  if (!payment) return undefined;

  const order = (await sql<{ subtotalMinor: string; taxMinor: string; totalMinor: string; currency: string; paymentStatus: string }>`
    select "subtotalMinor","taxMinor","totalMinor","currency","paymentStatus" from app.orders where "id"=${payment.orderId}::uuid and "businessId"=${businessId}::uuid for update
  `.execute(c.transaction)).rows[0]!;
  const snapshot: OrderSnapshot = { currency: order.currency, subtotalMinor: order.subtotalMinor, taxMinor: order.taxMinor, totalMinor: order.totalMinor };

  if (payment.status !== "pending") return { captured: false, isFullyPaid: order.paymentStatus === "paid", amountMinor: payment.amountMinor, method: payment.method, order: snapshot };

  const allocated = (await sql<{ total: string }>`select coalesce(sum("amountMinor"),0)::text total from app.payment_allocations where "businessId"=${businessId}::uuid and "orderId"=${payment.orderId}::uuid`.execute(c.transaction)).rows[0]?.total ?? "0";
  const isFullyPaid = await allocate(c, businessId, payment.orderId, paymentId, payment.amountMinor, allocated, order.totalMinor);
  await sql`update app.payments set "status"='captured' where "id"=${paymentId}::uuid`.execute(c.transaction);

  return { captured: true, isFullyPaid, amountMinor: payment.amountMinor, method: payment.method, order: snapshot };
}

export async function markCheckoutPaymentFailed(c: DatabaseContext, businessId: string, paymentId: string): Promise<void> {
  await sql`update app.payments set "status"='failed' where "id"=${paymentId}::uuid and "businessId"=${businessId}::uuid and "status"='pending'`.execute(c.transaction);
}

export async function listPayments(
  c: DatabaseContext,
  businessId: string,
  filter: ListPaymentsFilter = {},
): Promise<{ payments: PaymentRow[]; totalCount: number }> {
  const limit = Math.max(1, Math.min(100, filter.limit ?? 50));
  const offset = Math.max(0, filter.offset ?? 0);

  const rows = (await sql<PaymentRow>`
    select 
      p."id",
      p."businessId",
      p."orderId",
      p."method",
      p."status",
      p."assetCode",
      p."amountMinor"::text as "amountMinor",
      p."externalReference",
      p."idempotencyKey",
      p."createdBy"::text as "createdBy",
      p."createdAt"::text as "createdAt",
      p."updatedAt"::text as "updatedAt",
      o."orderNumber",
      o."totalMinor"::text as "orderTotalMinor",
      coalesce(pt."displayName", '') as "customerName",
      coalesce(pc."value", '') as "customerEmail"
    from app.payments p
    left join app.orders o on o."id" = p."orderId" and o."businessId" = p."businessId"
    left join app.parties pt on pt."id" = o."customerPartyId" and pt."businessId" = p."businessId"
    left join lateral (
      select "value"
      from app.party_contacts
      where "partyId" = pt."id" and "businessId" = pt."businessId"
        and "kind" = 'email' and "status" = 'active'
      order by "isPrimary" desc
      limit 1
    ) pc on true
    where p."businessId" = ${businessId}::uuid
      and (${filter.orderId ?? null}::uuid is null or p."orderId" = ${filter.orderId ?? null}::uuid)
      and (${filter.status ?? null}::text is null or p."status" = ${filter.status ?? null})
      and (${filter.method ?? null}::text is null or p."method" = ${filter.method ?? null})
    order by p."createdAt" desc
    limit ${limit} offset ${offset}
  `.execute(c.transaction)).rows;

  const countRow = (await sql<{ count: string }>`
    select count(*)::text as count
    from app.payments p
    where p."businessId" = ${businessId}::uuid
      and (${filter.orderId ?? null}::uuid is null or p."orderId" = ${filter.orderId ?? null}::uuid)
      and (${filter.status ?? null}::text is null or p."status" = ${filter.status ?? null})
      and (${filter.method ?? null}::text is null or p."method" = ${filter.method ?? null})
  `.execute(c.transaction)).rows[0];

  return {
    payments: rows,
    totalCount: Number(countRow?.count ?? 0),
  };
}

export async function findPaymentById(
  c: DatabaseContext,
  businessId: string,
  paymentId: string,
): Promise<PaymentRow | undefined> {
  const row = (await sql<PaymentRow>`
    select 
      p."id",
      p."businessId",
      p."orderId",
      p."method",
      p."status",
      p."assetCode",
      p."amountMinor"::text as "amountMinor",
      p."externalReference",
      p."idempotencyKey",
      p."createdBy"::text as "createdBy",
      p."createdAt"::text as "createdAt",
      p."updatedAt"::text as "updatedAt",
      o."orderNumber",
      o."totalMinor"::text as "orderTotalMinor",
      coalesce(pt."displayName", '') as "customerName",
      coalesce(pc."value", '') as "customerEmail"
    from app.payments p
    left join app.orders o on o."id" = p."orderId" and o."businessId" = p."businessId"
    left join app.parties pt on pt."id" = o."customerPartyId" and pt."businessId" = p."businessId"
    left join lateral (
      select "value"
      from app.party_contacts
      where "partyId" = pt."id" and "businessId" = pt."businessId"
        and "kind" = 'email' and "status" = 'active'
      order by "isPrimary" desc
      limit 1
    ) pc on true
    where p."businessId" = ${businessId}::uuid
      and p."id" = ${paymentId}::uuid
  `.execute(c.transaction)).rows[0];

  return row;
}
