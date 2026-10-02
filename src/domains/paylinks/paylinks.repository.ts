import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { loadEnvironment } from "../../shared/environment.js";
import { conflictError } from "../../shared/errors.js";
import type {
  CreatePaylinkInput,
  DeliveryAddress,
  PaylinkAmountType,
  PaylinkMode,
  PaylinkPaymentSummary,
  PaylinkRow,
  PaylinkStatus,
  PaylinkSummary,
  UpdatePaylinkInput,
} from "./paylinks.types.js";

export function publicPaylinkUrl(slug: string): string {
  return `${loadEnvironment().FRONTEND_URL.replace(/\/+$/, "")}/pay/${slug}`;
}

export async function findDefaultStore(
  context: DatabaseContext,
  businessId: string,
): Promise<{ id: string; currency: string } | undefined> {
  const result = await sql<{ id: string; currency: string | null }>`
    select s."id", b."defaultCurrency" as "currency"
    from app.stores s
    join app.businesses b on b."id" = s."businessId"
    where s."businessId" = ${businessId}::uuid and s."status" <> 'archived'
    order by s."createdAt"
    limit 1
  `.execute(context.transaction);
  const row = result.rows[0];
  if (!row) return undefined;
  return { id: row.id, currency: row.currency ?? "NGN" };
}

export async function countActivePaylinks(context: DatabaseContext, businessId: string): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*) as "count" from app.paylinks where "businessId" = ${businessId}::uuid and "status" = 'active'
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? 0);
}

/** Business active and under no risk hold (migration 0084); callable without a business identity. */
export async function isBusinessAcceptingPayments(context: DatabaseContext, businessId: string): Promise<boolean> {
  const result = await sql<{ accepting: boolean }>`
    select app.business_accepting_payments(${businessId}::uuid) as "accepting"
  `.execute(context.transaction);
  return result.rows[0]?.accepting ?? false;
}

export async function listStalePaylinkPayments(context: DatabaseContext, olderThanMinutes: number, afterCreatedAt: Date | null, maxRows: number): Promise<{ reference: string; createdAt: Date }[]> {
  const result = await sql<{ reference: string; createdAt: Date }>`
    select * from app.list_stale_paylink_payments(${`${olderThanMinutes} minutes`}::interval, ${afterCreatedAt}::timestamptz, ${maxRows})
  `.execute(context.transaction);
  return result.rows;
}

export async function countRecentWebhookSignatureFailures(context: DatabaseContext, withinMinutes: number): Promise<number> {
  const result = await sql<{ failures: number }>`
    select app.count_recent_webhook_signature_failures(${`${withinMinutes} minutes`}::interval) as "failures"
  `.execute(context.transaction);
  return Number(result.rows[0]?.failures ?? 0);
}

export async function ensurePaylinkChannel(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<string> {
  const existing = await sql<{ id: string }>`
    select "id" from app.sales_channels
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "kind" = 'payment_link' and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await sql<{ id: string }>`
    insert into app.sales_channels ("businessId", "storeId", "code", "name", "kind", "status")
    values (${businessId}::uuid, ${storeId}::uuid, 'payment_link', 'Payment Links', 'payment_link', 'active')
    on conflict do nothing
    returning "id"
  `.execute(context.transaction);

  if (created.rows[0]?.id) return created.rows[0].id;

  // If on conflict do nothing hit a race, select it again
  const retry = await sql<{ id: string }>`
    select "id" from app.sales_channels
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "kind" = 'payment_link'
    limit 1
  `.execute(context.transaction);

  if (!retry.rows[0]?.id) throw conflictError("Could not initialize the payment link sales channel");
  return retry.rows[0].id;
}

export async function isSlugAvailable(
  context: DatabaseContext,
  slug: string,
  excludePaylinkId?: string,
): Promise<boolean> {
  const result = await sql<{ count: string }>`
    select count(*) as count from app.paylinks
    where "slug" = ${slug}
      ${excludePaylinkId ? sql`and "id" <> ${excludePaylinkId}::uuid` : sql``}
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? 0) === 0;
}

/** A link image must be a confirmed product-image upload of this same business — never an arbitrary object key, which the public page would presign for anyone. */
export async function isConfirmedBusinessImage(context: DatabaseContext, businessId: string, objectKey: string): Promise<boolean> {
  const result = await sql<{ found: number }>`
    select 1 as "found" from app.uploads
    where "objectKey" = ${objectKey} and "businessId" = ${businessId}::uuid
      and "status" = 'confirmed' and "purpose" = 'product_image'
    limit 1
  `.execute(context.transaction);
  return result.rows.length > 0;
}

/** The variant's current business-wide price, as get_public_paylink resolves it. */
export async function findVariantPriceMinor(context: DatabaseContext, businessId: string, productVariantId: string): Promise<string | null> {
  const result = await sql<{ amountMinor: string }>`
    select pr."amountMinor"::text as "amountMinor"
    from app.product_variants v
    join app.product_prices pr on pr."productVariantId" = v."id" and pr."status" = 'active' and pr."locationId" is null
    where v."id" = ${productVariantId}::uuid and v."businessId" = ${businessId}::uuid
    order by pr."effectiveFrom" desc nulls last
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.amountMinor ?? null;
}

export async function createPaylink(
  context: DatabaseContext,
  businessId: string,
  userId: string,
  storeId: string,
  channelId: string,
  slug: string,
  input: CreatePaylinkInput,
): Promise<PaylinkRow> {
  const suggested = JSON.stringify(input.suggestedAmountsMinor?.map((a) => String(a)) ?? []);
  const result = await sql<PaylinkRow>`
    insert into app.paylinks (
      "businessId", "storeId", "channelId", "slug", "mode", "title", "description",
      "imageKey", "amountType", "amountMinor", "minAmountMinor", "suggestedAmountsMinor",
      "currency", "productVariantId", "collectName", "collectPhone", "collectAddress",
      "redirectUrl", "status", "expiresAt", "createdBy"
    ) values (
      ${businessId}::uuid,
      ${storeId}::uuid,
      ${channelId}::uuid,
      ${slug},
      ${input.mode},
      ${input.title},
      ${input.description ?? null},
      ${input.imageKey ?? null},
      ${input.amountType ?? "fixed"},
      ${input.amountMinor ? String(input.amountMinor) : null}::bigint,
      ${input.minAmountMinor ? String(input.minAmountMinor) : null}::bigint,
      ${suggested}::jsonb,
      ${input.currency ?? "NGN"},
      ${input.productVariantId ?? null}::uuid,
      ${input.collectName ?? true},
      ${input.collectPhone ?? true},
      ${input.collectAddress ?? false},
      ${input.redirectUrl ?? null},
      ${input.status ?? 'active'},
      ${input.expiresAt ? new Date(input.expiresAt) : null},
      ${userId}::uuid
    )
    returning *
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function findPaylinkById(
  context: DatabaseContext,
  businessId: string,
  paylinkId: string,
): Promise<PaylinkRow | undefined> {
  const result = await sql<PaylinkRow>`
    select * from app.paylinks
    where "id" = ${paylinkId}::uuid and "businessId" = ${businessId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listPaylinks(
  context: DatabaseContext,
  businessId: string,
  filter: {
    status?: string;
    search?: string;
    limit: number;
    offset: number;
  },
): Promise<{ paylinks: PaylinkSummary[]; totalCount: number }> {
  const statusFilter =
    filter.status && filter.status !== "all"
      ? sql`and p."status" = ${filter.status}`
      : sql`and p."status" <> 'archived'`;

  const searchFilter = filter.search
    ? sql`and (p."title" ilike ${"%" + filter.search + "%"} or p."slug" ilike ${"%" + filter.search + "%"})`
    : sql``;

  const countQuery = await sql<{ count: string }>`
    select count(*) as count
    from app.paylinks p
    where p."businessId" = ${businessId}::uuid
      ${statusFilter}
      ${searchFilter}
  `.execute(context.transaction);

  const totalCount = Number(countQuery.rows[0]?.count ?? 0);

  const rows = await sql<
    PaylinkRow & {
      paymentCount: string;
      totalCollectedMinor: string;
    }
  >`
    select
      p.*,
      coalesce(stats."paymentCount", 0)::text as "paymentCount",
      coalesce(stats."totalCollectedMinor", 0)::text as "totalCollectedMinor"
    from app.paylinks p
    left join (
      select
        o."paylinkId",
        count(pm."id") filter (where pm."status" in ('captured', 'authorized')) as "paymentCount",
        coalesce(sum(pm."amountMinor") filter (where pm."status" in ('captured', 'authorized')), 0) as "totalCollectedMinor"
      from app.orders o
      join app.payments pm on pm."orderId" = o."id" and pm."businessId" = o."businessId"
      where o."businessId" = ${businessId}::uuid and o."paylinkId" is not null
      group by o."paylinkId"
    ) stats on stats."paylinkId" = p."id"
    where p."businessId" = ${businessId}::uuid
      ${statusFilter}
      ${searchFilter}
    order by p."createdAt" desc
    limit ${filter.limit}
    offset ${filter.offset}
  `.execute(context.transaction);

  const paylinks: PaylinkSummary[] = rows.rows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    storeId: row.storeId,
    channelId: row.channelId,
    slug: row.slug,
    publicUrl: publicPaylinkUrl(row.slug),
    mode: row.mode as PaylinkMode,
    title: row.title,
    description: row.description,
    imageUrl: null,
    imageKey: row.imageKey,
    amountType: row.amountType as PaylinkAmountType,
    amountMinor: row.amountMinor ? String(row.amountMinor) : null,
    minAmountMinor: row.minAmountMinor ? String(row.minAmountMinor) : null,
    suggestedAmountsMinor: Array.isArray(row.suggestedAmountsMinor)
      ? (row.suggestedAmountsMinor as string[])
      : [],
    currency: row.currency,
    productVariantId: row.productVariantId,
    collectName: row.collectName,
    collectPhone: row.collectPhone,
    collectAddress: row.collectAddress,
    redirectUrl: row.redirectUrl,
    status: row.status as PaylinkStatus,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    paymentCount: Number(row.paymentCount ?? 0),
    totalCollectedMinor: String(row.totalCollectedMinor ?? "0"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return { paylinks, totalCount };
}

export async function updatePaylink(
  context: DatabaseContext,
  businessId: string,
  paylinkId: string,
  input: UpdatePaylinkInput,
): Promise<PaylinkRow | undefined> {
  const fields: ReturnType<typeof sql>[] = [];

  if (input.title !== undefined) fields.push(sql`"title" = ${input.title}`);
  if (input.description !== undefined) fields.push(sql`"description" = ${input.description}`);
  if (input.imageKey !== undefined) fields.push(sql`"imageKey" = ${input.imageKey}`);
  if (input.amountType !== undefined) fields.push(sql`"amountType" = ${input.amountType}`);
  if (input.amountMinor !== undefined)
    fields.push(sql`"amountMinor" = ${input.amountMinor ? String(input.amountMinor) : null}::bigint`);
  if (input.minAmountMinor !== undefined)
    fields.push(sql`"minAmountMinor" = ${input.minAmountMinor ? String(input.minAmountMinor) : null}::bigint`);
  if (input.suggestedAmountsMinor !== undefined)
    fields.push(sql`"suggestedAmountsMinor" = ${JSON.stringify(input.suggestedAmountsMinor.map((a) => String(a)))}::jsonb`);
  if (input.collectName !== undefined) fields.push(sql`"collectName" = ${input.collectName}`);
  if (input.collectPhone !== undefined) fields.push(sql`"collectPhone" = ${input.collectPhone}`);
  if (input.collectAddress !== undefined) fields.push(sql`"collectAddress" = ${input.collectAddress}`);
  if (input.redirectUrl !== undefined) fields.push(sql`"redirectUrl" = ${input.redirectUrl}`);
  if (input.expiresAt !== undefined)
    fields.push(sql`"expiresAt" = ${input.expiresAt ? new Date(input.expiresAt) : null}`);
  if (input.status !== undefined) fields.push(sql`"status" = ${input.status}`);

  if (fields.length === 0) return findPaylinkById(context, businessId, paylinkId);

  const result = await sql<PaylinkRow>`
    update app.paylinks
    set ${sql.join(fields, sql`, `)}
    where "id" = ${paylinkId}::uuid and "businessId" = ${businessId}::uuid
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}

export async function archivePaylink(
  context: DatabaseContext,
  businessId: string,
  paylinkId: string,
): Promise<PaylinkRow | undefined> {
  const result = await sql<PaylinkRow>`
    update app.paylinks
    set "status" = 'archived'
    where "id" = ${paylinkId}::uuid and "businessId" = ${businessId}::uuid
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listPaylinkPayments(
  context: DatabaseContext,
  businessId: string,
  paylinkId: string,
): Promise<PaylinkPaymentSummary[]> {
  const result = await sql<{
    id: string;
    orderId: string;
    amountMinor: string;
    currency: string;
    status: string;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    deliveryAddress: DeliveryAddress | null;
    reference: string;
    paidAt: Date | null;
    createdAt: Date;
  }>`
    select
      pm."id",
      pm."orderId",
      pm."amountMinor"::text,
      pm."assetCode" as "currency",
      pm."status",
      party."displayName" as "customerName",
      email."value" as "customerEmail",
      phone."value" as "customerPhone",
      o."deliveryAddress",
      coalesce(pm."externalReference", pm."id"::text) as "reference",
      case when pm."status" = 'captured' then pm."updatedAt" else null end as "paidAt",
      pm."createdAt"
    from app.payments pm
    join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
    left join app.parties party on party."id" = o."customerPartyId" and party."businessId" = o."businessId"
    left join lateral (
      select c."value" from app.party_contacts c
      where c."partyId" = party."id" and c."businessId" = party."businessId" and c."kind" = 'email'
      order by c."isPrimary" desc limit 1
    ) email on true
    left join lateral (
      select c."value" from app.party_contacts c
      where c."partyId" = party."id" and c."businessId" = party."businessId" and c."kind" = 'phone'
      order by c."isPrimary" desc limit 1
    ) phone on true
    where o."businessId" = ${businessId}::uuid and o."paylinkId" = ${paylinkId}::uuid
    order by pm."createdAt" desc
  `.execute(context.transaction);

  return result.rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    deliveryAddress: row.deliveryAddress,
    reference: row.reference,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface PublicPaylinkData {
  id: string;
  businessId: string;
  storeId: string;
  channelId: string;
  slug: string;
  mode: string;
  title: string;
  description: string | null;
  imageKey: string | null;
  amountType: string;
  amountMinor: string | null;
  minAmountMinor: string | null;
  suggestedAmountsMinor: string[];
  currency: string;
  productVariantId: string | null;
  collectName: boolean;
  collectPhone: boolean;
  collectAddress: boolean;
  redirectUrl: string | null;
  status: string;
  expiresAt: string | null;
  businessName: string;
  product: {
    name: string;
    sku: string | null;
    description: string | null;
    priceMinor: string | null;
  } | null;
}

export async function findPublicPaylink(
  context: DatabaseContext,
  slug: string,
): Promise<PublicPaylinkData | null> {
  const result = await sql<{ paylink: PublicPaylinkData | null }>`
    select app.get_public_paylink(${slug}) as "paylink"
  `.execute(context.transaction);
  return result.rows[0]?.paylink ?? null;
}

export interface GuestCheckoutRecord {
  readonly orderId: string;
  readonly paymentId: string;
  readonly reference: string;
  readonly checkoutUrl: string | null;
  readonly replayed: boolean;
}

export async function createGuestOrderAndPayment(
  context: DatabaseContext,
  params: {
    slug: string;
    customerName: string;
    customerEmail: string;
    customerPhone?: string | null;
    orderNumber: string;
    amountMinor: bigint;
    currency: string;
    description: string;
    productVariantId: string | null;
    quantity: number;
    providerName: string;
    providerReference: string;
    idempotencyKey: string;
    deliveryAddress: DeliveryAddress | null;
  },
): Promise<GuestCheckoutRecord> {
  const result = await sql<GuestCheckoutRecord>`
    select * from app.record_public_paylink_checkout(
      ${params.slug},
      ${params.customerName},
      ${params.customerEmail},
      ${params.customerPhone ?? null},
      ${params.orderNumber},
      ${params.amountMinor.toString()}::bigint,
      ${params.currency},
      ${params.description},
      ${params.productVariantId ?? null}::uuid,
      ${params.quantity},
      ${params.providerName},
      ${params.providerReference},
      ${params.idempotencyKey},
      ${params.deliveryAddress ? JSON.stringify(params.deliveryAddress) : null}::jsonb
    )
  `.execute(context.transaction);

  if (!result.rows[0]) throw conflictError("Failed to record guest checkout");
  return result.rows[0];
}

export async function setCheckoutUrl(context: DatabaseContext, reference: string, checkoutUrl: string): Promise<void> {
  await sql`select app.set_paylink_checkout_url(${reference}, ${checkoutUrl})`.execute(context.transaction);
}

export async function findPaymentByReference(
  context: DatabaseContext,
  reference: string,
): Promise<
  | {
      reference: string;
      status: string;
      amountMinor: string;
      currency: string;
      paidAt: Date | null;
      redirectUrl: string | null;
    }
  | undefined
> {
  const result = await sql<{
    reference: string;
    status: string;
    amountMinor: string;
    currency: string;
    paidAt: Date | null;
    redirectUrl: string | null;
  }>`
    select * from app.get_public_paylink_checkout_status(${reference})
  `.execute(context.transaction);

  return result.rows[0];
}

