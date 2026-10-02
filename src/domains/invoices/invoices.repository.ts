import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { conflictError, notFoundError } from "../../shared/errors.js";
import type {
  CreateInvoiceLineInput,
  InvoiceLineRow,
  InvoiceMetrics,
  InvoiceRow,
  ListInvoicesFilter,
} from "./invoices.types.js";

export interface ComputedInvoiceTotals {
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly discountMinor: bigint;
  readonly totalMinor: bigint;
  readonly lines: Array<{
    description: string;
    quantity: number;
    unitPriceMinor: bigint;
    taxRateBps: number;
    discountMinor: bigint;
    lineTotalMinor: bigint;
    productVariantId: string | null;
    sortOrder: number;
  }>;
}

export function computeInvoiceTotals(
  rawLines: CreateInvoiceLineInput[],
  overallDiscountMinor: string | number | bigint = 0n,
): ComputedInvoiceTotals {
  let subtotal = 0n;
  let tax = 0n;
  let linesDiscount = 0n;

  const lines = rawLines.map((line, index) => {
    const qty = Number(line.quantity);
    const unitPrice = BigInt(line.unitPriceMinor);
    // Integer-safe minor calculation
    const lineSubtotal = (unitPrice * BigInt(Math.round(qty * 10000))) / 10000n;
    const taxRateBps = BigInt(line.taxRateBps ?? 0);
    const lineTax = (lineSubtotal * taxRateBps) / 10000n;
    const lineDisc = BigInt(line.discountMinor ?? 0n);
    const lineTotal = lineSubtotal + lineTax > lineDisc ? lineSubtotal + lineTax - lineDisc : 0n;

    subtotal += lineSubtotal;
    tax += lineTax;
    linesDiscount += lineDisc;

    return {
      description: line.description,
      quantity: qty,
      unitPriceMinor: unitPrice,
      taxRateBps: Number(taxRateBps),
      discountMinor: lineDisc,
      lineTotalMinor: lineTotal,
      productVariantId: line.productVariantId ?? null,
      sortOrder: line.sortOrder ?? index,
    };
  });

  const totalDiscount = linesDiscount + BigInt(overallDiscountMinor);
  const total = subtotal + tax > totalDiscount ? subtotal + tax - totalDiscount : 0n;

  return {
    subtotalMinor: subtotal,
    taxMinor: tax,
    discountMinor: totalDiscount,
    totalMinor: total,
    lines,
  };
}

export async function ensureManualInvoiceChannel(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<string> {
  const existing = await sql<{ id: string }>`
    select "id" from app.sales_channels
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "kind" = 'manual_invoice' and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await sql<{ id: string }>`
    insert into app.sales_channels ("businessId", "storeId", "code", "name", "kind")
    values (${businessId}::uuid, ${storeId}::uuid, 'manual_invoice', 'Manual Invoices', 'manual_invoice')
    returning "id"
  `.execute(context.transaction);
  if (!created.rows[0]) throw conflictError("Could not initialize the manual invoice sales channel");
  return created.rows[0].id;
}

/** An existing customer of this business with this email, so re-typing a known customer reuses their record instead of creating a duplicate. */
export async function findCustomerPartyByEmail(
  context: DatabaseContext,
  businessId: string,
  email: string,
): Promise<string | undefined> {
  const res = await sql<{ partyId: string }>`
    select pc."partyId"
    from app.party_contacts pc
    join app.parties p on p."id" = pc."partyId" and p."businessId" = pc."businessId"
    where pc."businessId" = ${businessId}::uuid and pc."kind" = 'email' and pc."status" = 'active'
      and lower(pc."value") = lower(${email}) and p."status" = 'active'
    order by pc."isPrimary" desc, pc."createdAt"
    limit 1
  `.execute(context.transaction);
  return res.rows[0]?.partyId;
}

export async function findDefaultStore(
  context: DatabaseContext,
  businessId: string,
): Promise<{ id: string; currency: string } | undefined> {
  const res = await sql<{ id: string; currency: string }>`
    select s."id", b."defaultCurrency" as "currency"
    from app.stores s
    join app.businesses b on b."id" = s."businessId"
    where s."businessId" = ${businessId}::uuid and s."isDefault" and s."status" <> 'archived'
    limit 1
  `.execute(context.transaction);
  return res.rows[0];
}

export async function findActiveVirtualAccount(
  context: DatabaseContext,
  businessId: string,
): Promise<{ id: string; bankName: string | null; accountNumber: string | null; accountName: string | null } | undefined> {
  const res = await sql<{ id: string; bankName: string | null; accountNumber: string | null; accountName: string | null }>`
    select "id", "bankName", "accountNumber", "accountName"
    from app.virtual_accounts
    where "businessId" = ${businessId}::uuid and "status" = 'active'
    order by "createdAt" desc
    limit 1
  `.execute(context.transaction);
  return res.rows[0];
}

export async function createDraft(
  context: DatabaseContext,
  businessId: string,
  userId: string,
  fields: {
    storeId: string;
    channelId: string;
    customerPartyId: string;
    issueDate?: string;
    dueDate: string;
    currency: string;
    notes?: string;
    terms?: string;
  },
  totals: ComputedInvoiceTotals,
): Promise<InvoiceRow> {
  const invoiceRes = await sql<InvoiceRow>`
    insert into app.invoices (
      "businessId", "storeId", "channelId", "customerPartyId", "status",
      "issueDate", "dueDate", "currency", "subtotalMinor", "taxMinor",
      "discountMinor", "totalMinor", "notes", "terms", "createdBy"
    ) values (
      ${businessId}::uuid, ${fields.storeId}::uuid, ${fields.channelId}::uuid, ${fields.customerPartyId}::uuid, 'draft',
      coalesce(${fields.issueDate}::date, current_date), ${fields.dueDate}::date, ${fields.currency},
      ${totals.subtotalMinor}::bigint, ${totals.taxMinor}::bigint, ${totals.discountMinor}::bigint,
      ${totals.totalMinor}::bigint, ${fields.notes ?? null}, ${fields.terms ?? null}, ${userId}::uuid
    )
    returning *
  `.execute(context.transaction);

  const invoice = invoiceRes.rows[0]!;

  for (const line of totals.lines) {
    await sql`
      insert into app.invoice_lines (
        "businessId", "invoiceId", "productVariantId", "description",
        "quantity", "unitPriceMinor", "taxRateBps", "discountMinor",
        "lineTotalMinor", "sortOrder"
      ) values (
        ${businessId}::uuid, ${invoice.id}::uuid, ${line.productVariantId}::uuid, ${line.description},
        ${line.quantity}::numeric, ${line.unitPriceMinor}::bigint, ${line.taxRateBps}::integer,
        ${line.discountMinor}::bigint, ${line.lineTotalMinor}::bigint, ${line.sortOrder}::integer
      )
    `.execute(context.transaction);
  }

  return invoice;
}

export async function updateDraft(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
  fields: {
    storeId?: string;
    channelId?: string;
    customerPartyId?: string;
    issueDate?: string;
    dueDate?: string;
    currency?: string;
    notes?: string;
    terms?: string;
  },
  totals?: ComputedInvoiceTotals,
): Promise<InvoiceRow> {
  const current = await find(context, businessId, invoiceId);
  if (!current) throw notFoundError("Invoice not found");
  if (current.status !== "draft") throw conflictError("Only draft invoices can be edited");

  const setClauses: RawBuilder<unknown>[] = [];
  if (fields.storeId) setClauses.push(sql`"storeId" = ${fields.storeId}::uuid`);
  if (fields.channelId) setClauses.push(sql`"channelId" = ${fields.channelId}::uuid`);
  if (fields.customerPartyId) setClauses.push(sql`"customerPartyId" = ${fields.customerPartyId}::uuid`);
  if (fields.issueDate) setClauses.push(sql`"issueDate" = ${fields.issueDate}::date`);
  if (fields.dueDate) setClauses.push(sql`"dueDate" = ${fields.dueDate}::date`);
  if (fields.currency) setClauses.push(sql`"currency" = ${fields.currency}`);
  if (fields.notes !== undefined) setClauses.push(sql`"notes" = ${fields.notes}`);
  if (fields.terms !== undefined) setClauses.push(sql`"terms" = ${fields.terms}`);

  if (totals) {
    setClauses.push(sql`"subtotalMinor" = ${totals.subtotalMinor}::bigint`);
    setClauses.push(sql`"taxMinor" = ${totals.taxMinor}::bigint`);
    setClauses.push(sql`"discountMinor" = ${totals.discountMinor}::bigint`);
    setClauses.push(sql`"totalMinor" = ${totals.totalMinor}::bigint`);
  }

  let updated = current;
  if (setClauses.length > 0) {
    const res = await sql<InvoiceRow>`
      update app.invoices
      set ${sql.join(setClauses, sql`, `)}
      where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid and "status" = 'draft'
      returning *
    `.execute(context.transaction);
    updated = res.rows[0]!;
  }

  if (totals) {
    await sql`delete from app.invoice_lines where "businessId" = ${businessId}::uuid and "invoiceId" = ${invoiceId}::uuid`.execute(context.transaction);
    for (const line of totals.lines) {
      await sql`
        insert into app.invoice_lines (
          "businessId", "invoiceId", "productVariantId", "description",
          "quantity", "unitPriceMinor", "taxRateBps", "discountMinor",
          "lineTotalMinor", "sortOrder"
        ) values (
          ${businessId}::uuid, ${invoiceId}::uuid, ${line.productVariantId}::uuid, ${line.description},
          ${line.quantity}::numeric, ${line.unitPriceMinor}::bigint, ${line.taxRateBps}::integer,
          ${line.discountMinor}::bigint, ${line.lineTotalMinor}::bigint, ${line.sortOrder}::integer
        )
      `.execute(context.transaction);
    }
  }

  return updated;
}

export async function deleteDraft(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<void> {
  const res = await sql`
    delete from app.invoices
    where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid and "status" = 'draft'
  `.execute(context.transaction);
  if (Number(res.numAffectedRows ?? 0) === 0) {
    const existing = await find(context, businessId, invoiceId);
    if (!existing) throw notFoundError("Invoice not found");
    throw conflictError("Only draft invoices can be deleted");
  }
}

export async function find(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<InvoiceRow | undefined> {
  const res = await sql<InvoiceRow>`
    select * from app.invoices
    where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid
    limit 1
  `.execute(context.transaction);
  return res.rows[0];
}

export async function lockForUpdate(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<InvoiceRow | undefined> {
  const res = await sql<InvoiceRow>`
    select * from app.invoices
    where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid
    for update
  `.execute(context.transaction);
  return res.rows[0];
}

export async function lines(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<InvoiceLineRow[]> {
  const res = await sql<InvoiceLineRow>`
    select * from app.invoice_lines
    where "businessId" = ${businessId}::uuid and "invoiceId" = ${invoiceId}::uuid
    order by "sortOrder", "createdAt", "id"
  `.execute(context.transaction);
  return res.rows;
}

export interface HydratedInvoiceData extends InvoiceRow {
  readonly customerName?: string | null;
  readonly customerEmail?: string | null;
  readonly customerPhone?: string | null;
  readonly orderPaymentStatus?: string | null;
  readonly amountPaidMinor?: string | null;
  /** Due date is before today in the store's own time zone (app.invoice_local_today). */
  readonly isPastDue?: boolean;
  /** Same rule as the service's status: void/draft from the row, otherwise paid / partially_paid / overdue / pending from payments and the due date. */
  readonly derivedStatus?: string;
}

/**
 * Every invoice read goes through this one derived row (aliased `inv`), so the
 * list's status filter, the metrics cards and the detail view all agree on
 * what "paid", "overdue" and "pending" mean.
 */
const INVOICE_QUERY_CONTEXT = sql`
  select * from (
    select base.*,
      case
        when base."status" = 'void' then 'void'
        when base."status" = 'draft' then 'draft'
        when base."orderPaymentStatus" = 'paid' or (base."totalMinor" > 0 and base."amountPaidNumeric" >= base."totalMinor") then 'paid'
        when base."amountPaidNumeric" > 0 then 'partially_paid'
        when base."isPastDue" then 'overdue'
        else 'pending'
      end as "derivedStatus"
    from (
      select i.*,
        p."displayName" as "customerName",
        (select pc."value" from app.party_contacts pc
         where pc."partyId" = i."customerPartyId" and pc."businessId" = i."businessId" and pc."kind" = 'email' and pc."status" = 'active'
         order by pc."isPrimary" desc, pc."createdAt" limit 1) as "customerEmail",
        (select pc."value" from app.party_contacts pc
         where pc."partyId" = i."customerPartyId" and pc."businessId" = i."businessId" and pc."kind" = 'phone' and pc."status" = 'active'
         order by pc."isPrimary" desc, pc."createdAt" limit 1) as "customerPhone",
        o."paymentStatus" as "orderPaymentStatus",
        paid."amount"::text as "amountPaidMinor",
        paid."amount" as "amountPaidNumeric",
        (i."dueDate" < app.invoice_local_today(i."storeId")) as "isPastDue"
      from app.invoices i
      left join app.parties p on p."id" = i."customerPartyId" and p."businessId" = i."businessId"
      left join app.orders o on o."id" = i."orderId" and o."businessId" = i."businessId"
      left join lateral (
        select coalesce(sum(pay."amountMinor"), 0) as "amount" from app.payments pay
        where pay."orderId" = i."orderId" and pay."businessId" = i."businessId" and pay."status" in ('captured', 'authorized')
      ) paid on true
    ) base
  ) inv
`;

export async function findHydrated(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<HydratedInvoiceData | undefined> {
  const res = await sql<HydratedInvoiceData>`
    ${INVOICE_QUERY_CONTEXT}
    where inv."businessId" = ${businessId}::uuid and inv."id" = ${invoiceId}::uuid
    limit 1
  `.execute(context.transaction);
  return res.rows[0];
}

export async function list(
  context: DatabaseContext,
  businessId: string,
  filter: ListInvoicesFilter = {},
): Promise<HydratedInvoiceData[]> {
  const clauses: RawBuilder<unknown>[] = [sql`inv."businessId" = ${businessId}::uuid`];

  if (filter.status) {
    clauses.push(sql`inv."derivedStatus" = ${filter.status}`);
  }

  if (filter.customerId) {
    clauses.push(sql`inv."customerPartyId" = ${filter.customerId}::uuid`);
  }

  if (filter.search) {
    const term = `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(sql`(inv."invoiceNumber" ilike ${term} or inv."customerName" ilike ${term})`);
  }

  const whereClause = sql.join(clauses, sql` and `);
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  const res = await sql<HydratedInvoiceData>`
    ${INVOICE_QUERY_CONTEXT}
    where ${whereClause}
    order by inv."createdAt" desc, inv."id" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);

  return res.rows;
}

/** Drafts are not invoiced yet and void invoices are cancelled, so only sent (open) invoices count towards the cards. */
export async function getMetrics(
  context: DatabaseContext,
  businessId: string,
): Promise<InvoiceMetrics> {
  const res = await sql<{ totalMinor: string; amountPaidMinor: string; derivedStatus: string }>`
    ${INVOICE_QUERY_CONTEXT}
    where inv."businessId" = ${businessId}::uuid and inv."status" = 'open'
  `.execute(context.transaction);

  let totalInvoiced = 0n;
  let paidAmount = 0n;
  let pendingAmount = 0n;
  let overdueAmount = 0n;
  let paidCount = 0;
  let pendingCount = 0;
  let overdueCount = 0;

  for (const row of res.rows) {
    const total = BigInt(row.totalMinor);
    const paid = BigInt(row.amountPaidMinor);
    const remaining = total > paid ? total - paid : 0n;

    totalInvoiced += total;
    paidAmount += paid;

    if (row.derivedStatus === "paid") {
      paidCount++;
    } else if (row.derivedStatus === "overdue") {
      overdueAmount += remaining;
      overdueCount++;
    } else {
      pendingAmount += remaining;
      pendingCount++;
    }
  }

  return {
    totalInvoicedMinor: totalInvoiced.toString(),
    paidAmountMinor: paidAmount.toString(),
    pendingAmountMinor: pendingAmount.toString(),
    overdueAmountMinor: overdueAmount.toString(),
    totalCount: res.rows.length,
    paidCount,
    pendingCount,
    overdueCount,
  };
}

export async function markSent(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
  fields: {
    orderId: string;
    fiscalDocumentId: string;
    invoiceNumber: string;
    payToVirtualAccountId?: string | null;
    payToBankName?: string | null;
    payToAccountNumber?: string | null;
    payToAccountName?: string | null;
  },
): Promise<InvoiceRow> {
  const res = await sql<InvoiceRow>`
    update app.invoices
    set "status" = 'open',
        "sentAt" = coalesce("sentAt", now()),
        "orderId" = ${fields.orderId}::uuid,
        "fiscalDocumentId" = ${fields.fiscalDocumentId}::uuid,
        "invoiceNumber" = ${fields.invoiceNumber},
        "payToVirtualAccountId" = ${fields.payToVirtualAccountId ?? null}::uuid,
        "payToBankName" = ${fields.payToBankName ?? null},
        "payToAccountNumber" = ${fields.payToAccountNumber ?? null},
        "payToAccountName" = ${fields.payToAccountName ?? null}
    where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid
    returning *
  `.execute(context.transaction);
  return res.rows[0]!;
}

export async function markVoid(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<InvoiceRow> {
  const res = await sql<InvoiceRow>`
    update app.invoices
    set "status" = 'void',
        "voidedAt" = coalesce("voidedAt", now())
    where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid
    returning *
  `.execute(context.transaction);
  return res.rows[0]!;
}

export async function recordReminderSent(
  context: DatabaseContext,
  businessId: string,
  invoiceId: string,
): Promise<void> {
  await sql`
    update app.invoices
    set "lastReminderAt" = now()
    where "businessId" = ${businessId}::uuid and "id" = ${invoiceId}::uuid
  `.execute(context.transaction);
}

export async function findByPublicToken(
  context: DatabaseContext,
  token: string,
): Promise<Record<string, unknown> | null> {
  const res = await sql<{ invoice: Record<string, unknown> | null }>`
    select app.get_public_invoice(${token}) as "invoice"
  `.execute(context.transaction);
  return res.rows[0]?.invoice ?? null;
}

export interface PublicPaymentTarget {
  invoiceId: string;
  businessId: string;
  orderId: string;
  createdBy: string;
  status: string;
  currency: string;
  totalMinor: string;
  balanceDueMinor: string;
  customerEmail: string | null;
  customerName: string | null;
  /** A checkout opened in the last 30 minutes for exactly the current balance and still pending — reused instead of opening another one. */
  reusableCheckoutReference: string | null;
  reusableCheckoutUrl: string | null;
}

/** Locks the invoice row until the transaction ends, so concurrent pay requests for one invoice are serialised. */
export async function getPublicPaymentTarget(
  context: DatabaseContext,
  token: string,
): Promise<PublicPaymentTarget | null> {
  const res = await sql<PublicPaymentTarget>`
    select * from app.get_public_invoice_payment_target(${token})
  `.execute(context.transaction);
  return res.rows[0] ?? null;
}

export async function recordPublicPayment(
  context: DatabaseContext,
  token: string,
  provider: string,
  providerReference: string,
  idempotencyKey: string,
  authorizationUrl: string,
): Promise<string> {
  const res = await sql<{ id: string }>`
    select app.record_public_invoice_payment(${token}, ${provider}, ${providerReference}, ${idempotencyKey}, ${authorizationUrl}) as "id"
  `.execute(context.transaction);
  return res.rows[0]!.id;
}

export interface OverdueSweepCandidate {
  id: string;
  businessId: string;
  invoiceNumber: string | null;
  currency: string;
  totalMinor: string;
  balanceDueMinor: string;
  dueDate: Date | string;
  businessName: string;
  customerName: string;
  customerEmail: string;
  publicToken: string;
}

export async function listOverdueInvoicesForSweep(
  context: DatabaseContext,
): Promise<OverdueSweepCandidate[]> {
  const res = await sql<OverdueSweepCandidate>`
    select * from app.list_overdue_invoices_for_sweep()
  `.execute(context.transaction);
  return res.rows;
}

export async function recordSweepReminderSent(
  context: DatabaseContext,
  invoiceId: string,
): Promise<void> {
  await sql`
    select app.record_invoice_sweep_reminder_sent(${invoiceId}::uuid)
  `.execute(context.transaction);
}

export async function getNextInvoiceNumber(
  context: DatabaseContext,
  businessId: string,
): Promise<string> {
  const res = await sql<{ next: string }>`
    select coalesce(max("sequence"), 0) + 1 as "next"
    from app.fiscal_documents
    where "businessId" = ${businessId}::uuid and "kind" = 'invoice'
  `.execute(context.transaction);
  const sequence = res.rows[0]?.next ?? "1";
  return `INV-${sequence.padStart(6, "0")}`;
}

export interface InvoicePaymentNotification {
  readonly invoiceId: string;
  readonly businessId: string;
  readonly invoiceNumber: string | null;
  readonly publicToken: string;
  readonly currency: string;
  readonly totalMinor: string;
  readonly amountPaidMinor: string;
  readonly balanceDueMinor: string;
  readonly businessName: string;
  readonly ownerUserId: string | null;
  readonly merchantEmail: string | null;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
}

/** The open invoice behind an order, with what the "payment received" messages need; undefined when the order is not an invoice. */
export async function getPaymentNotification(
  context: DatabaseContext,
  orderId: string,
): Promise<InvoicePaymentNotification | undefined> {
  const res = await sql<InvoicePaymentNotification>`
    select "invoiceId", "businessId", "invoiceNumber", "publicToken", "currency",
      "totalMinor"::text, "amountPaidMinor"::text, "balanceDueMinor"::text,
      "businessName", "ownerUserId", "merchantEmail", "customerName", "customerEmail"
    from app.get_invoice_payment_notification(${orderId}::uuid)
  `.execute(context.transaction);
  return res.rows[0];
}

export interface ReportedTransfer {
  readonly invoiceId: string;
  readonly businessId: string;
  readonly invoiceNumber: string | null;
  readonly currency: string;
  readonly balanceDueMinor: string;
  readonly businessName: string;
  readonly ownerUserId: string | null;
  readonly merchantEmail: string | null;
  readonly customerName: string | null;
  readonly firstReport: boolean;
}

/** Records the customer's transfer report on an open, unpaid invoice; undefined when the link isn't payable. */
export async function reportPublicTransfer(
  context: DatabaseContext,
  token: string,
): Promise<ReportedTransfer | undefined> {
  const res = await sql<ReportedTransfer>`
    select "invoiceId", "businessId", "invoiceNumber", "currency", "balanceDueMinor"::text,
      "businessName", "ownerUserId", "merchantEmail", "customerName", "firstReport"
    from app.report_public_invoice_transfer(${token})
  `.execute(context.transaction);
  return res.rows[0];
}
