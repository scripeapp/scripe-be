import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { RecordPaymentInput } from "./payments.types.js";

export interface OrderSnapshot {
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
}

export interface RecordedPayment {
  readonly id: string;
  /** True only on the call whose amount first brings the order to fully paid. */
  readonly isFullyPaid: boolean;
  readonly order: OrderSnapshot;
}

export async function record(c: DatabaseContext, businessId: string, userId: string, input: RecordPaymentInput): Promise<RecordedPayment> {
  const existing = (await sql<{ id: string }>`select "id" from app.payments where "businessId"=${businessId}::uuid and "idempotencyKey"=${input.idempotencyKey}`.execute(c.transaction)).rows[0];
  if (existing) return { id: existing.id, isFullyPaid: false, order: { currency: input.assetCode, subtotalMinor: "0", taxMinor: "0", totalMinor: "0" } };

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

  let isFullyPaid = false;
  if (input.status === undefined || input.status === "captured") {
    await sql`insert into app.payment_allocations ("businessId","paymentId","orderId","amountMinor") values (${businessId}::uuid,${payment.id}::uuid,${input.orderId}::uuid,${input.amountMinor})`.execute(c.transaction);
    const next = BigInt(allocated) + BigInt(input.amountMinor);
    isFullyPaid = next >= BigInt(order.totalMinor);
    await sql`update app.orders set "paymentStatus"=case when ${next.toString()}::bigint >= "totalMinor" then 'paid' else 'partially_paid' end where "id"=${input.orderId}::uuid and "businessId"=${businessId}::uuid`.execute(c.transaction);
  }

  return { id: payment.id, isFullyPaid, order: { currency: order.currency, subtotalMinor: order.subtotalMinor, taxMinor: order.taxMinor, totalMinor: order.totalMinor } };
}
