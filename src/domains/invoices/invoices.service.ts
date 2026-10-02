import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import {
  AppError,
  conflictError,
  notFoundError,
  validationError,
} from "../../shared/errors.js";
import { emailSender } from "../../shared/email.js";
import { getCheckoutGateway } from "../../integrations/checkout-gateway.js";
import * as authorization from "../authorization/authorization.service.js";
import * as partiesRepo from "../parties/parties.repository.js";
import type { PaymentsService } from "../payments/payments.service.js";
import * as receiptsRepo from "../receipts/receipts.repository.js";
import * as repository from "./invoices.repository.js";
import { formatMinor, notifyInvoicePayment, notifyTransferReported, publicInvoiceUrl } from "./invoices.notifications.js";
import { requireCheckoutSubaccount } from "../banking/checkout-subaccounts.js";
import type {
  CreateInvoiceInput,
  Invoice,
  InvoiceLine,
  InvoiceMetrics,
  InvoiceOperation,
  InvoiceStatus,
  ListInvoicesFilter,
  RecordInvoicePaymentInput,
  UpdateInvoiceInput,
} from "./invoices.types.js";
import { sql } from "kysely";

export class InvoicesService {
  constructor(
    private readonly database: Database,
    private readonly paymentsService: PaymentsService,
  ) {}

  async list(
    operation: InvoiceOperation,
    filter: ListInvoicesFilter = {},
  ): Promise<Invoice[]> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.read");
      const rows = await repository.list(context, operation.businessId, filter);
      return Promise.all(rows.map((row) => this.hydrateRow(context, row)));
    });
  }

  async get(operation: InvoiceOperation, invoiceId: string): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.read");
      return this.hydrate(context, operation.businessId, invoiceId);
    });
  }

  async getMetrics(operation: InvoiceOperation): Promise<InvoiceMetrics> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.read");
      return repository.getMetrics(context, operation.businessId);
    });
  }

  async getNextNumber(operation: InvoiceOperation): Promise<string> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.read");
      return repository.getNextInvoiceNumber(context, operation.businessId);
    });
  }

  async createDraft(
    operation: InvoiceOperation,
    input: CreateInvoiceInput,
  ): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const customerPartyId = await this.resolveCustomer(context, operation, input.customerPartyId, input.customer);

      if (!customerPartyId) {
        throw conflictError("Customer is required to create an invoice");
      }

      let storeId = input.storeId;
      let currency = input.currency;
      if (!storeId || !currency) {
        const defaultStore = await repository.findDefaultStore(context, operation.businessId);
        if (!defaultStore) throw conflictError("No default store configured for this business");
        storeId = storeId ?? defaultStore.id;
        currency = currency ?? defaultStore.currency;
      }

      const channelId = await repository.ensureManualInvoiceChannel(context, operation.businessId, storeId);
      const totals = repository.computeInvoiceTotals(input.lines, input.discountMinor ?? 0n);

      const created = await repository.createDraft(
        context,
        operation.businessId,
        operation.userId,
        {
          storeId,
          channelId,
          customerPartyId,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          currency,
          notes: input.notes,
          terms: input.terms,
        },
        totals,
      );

      return this.hydrate(context, operation.businessId, created.id);
    });
  }

  async updateDraft(
    operation: InvoiceOperation,
    invoiceId: string,
    input: UpdateInvoiceInput,
  ): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const customerPartyId = input.customerPartyId || input.customer
        ? await this.resolveCustomer(context, operation, input.customerPartyId, input.customer)
        : undefined;

      // Orders reference (channelId, storeId), so a store change must move the draft to that store's invoice channel.
      const channelId = input.storeId
        ? await repository.ensureManualInvoiceChannel(context, operation.businessId, input.storeId)
        : undefined;

      // A discount-only edit still has to recompute totals, from the lines already saved.
      let totals: repository.ComputedInvoiceTotals | undefined;
      if (input.lines) {
        totals = repository.computeInvoiceTotals(input.lines, input.discountMinor ?? 0n);
      } else if (input.discountMinor !== undefined) {
        const existing = await repository.lines(context, operation.businessId, invoiceId);
        totals = repository.computeInvoiceTotals(
          existing.map((line) => ({
            description: line.description,
            quantity: Number(line.quantity),
            unitPriceMinor: line.unitPriceMinor,
            taxRateBps: line.taxRateBps,
            discountMinor: line.discountMinor,
            productVariantId: line.productVariantId ?? undefined,
            sortOrder: line.sortOrder,
          })),
          input.discountMinor,
        );
      }

      const updated = await repository.updateDraft(
        context,
        operation.businessId,
        invoiceId,
        {
          storeId: input.storeId,
          channelId,
          customerPartyId,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          currency: input.currency,
          notes: input.notes,
          terms: input.terms,
        },
        totals,
      );

      return this.hydrate(context, operation.businessId, updated.id);
    });
  }

  async deleteDraft(operation: InvoiceOperation, invoiceId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");
      await repository.deleteDraft(context, operation.businessId, invoiceId);
    });
  }

  /**
   * Issues the invoice in one transaction (order, order lines, fiscal number,
   * payout account snapshot), then emails the customer only after that
   * transaction has committed — an email must never announce an invoice
   * that was rolled back, and no network call holds the business row lock.
   */
  async send(
    operation: InvoiceOperation,
    invoiceId: string,
  ): Promise<Invoice> {
    const { invoice, newlySent, businessName } = await this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const current = await repository.lockForUpdate(context, operation.businessId, invoiceId);
      if (!current) throw notFoundError("Invoice not found");

      if (current.status === "open" && current.orderId && current.invoiceNumber) {
        return { invoice: await this.hydrate(context, operation.businessId, invoiceId), newlySent: false, businessName: "" };
      }

      if (current.status === "void") {
        throw conflictError("Cannot send a void invoice");
      }

      const invoiceLines = await repository.lines(context, operation.businessId, invoiceId);
      if (invoiceLines.length === 0) {
        throw conflictError("Invoice must have at least one line item before sending");
      }

      // 1. Create order
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${current.id.slice(0, 8).toUpperCase()}`;
      const orderRes = await sql<{ id: string }>`
        insert into app.orders (
          "businessId", "orderNumber", "storeId", "channelId", "customerPartyId",
          "currency", "status", "paymentStatus", "fulfillmentStatus",
          "subtotalMinor", "taxMinor", "discountMinor", "totalMinor", "createdBy"
        ) values (
          ${operation.businessId}::uuid, ${orderNumber}, ${current.storeId}::uuid, ${current.channelId}::uuid,
          ${current.customerPartyId}::uuid, ${current.currency}, 'placed', 'unpaid', 'unfulfilled',
          ${current.subtotalMinor}::bigint, ${current.taxMinor}::bigint, ${current.discountMinor}::bigint,
          ${current.totalMinor}::bigint, ${operation.userId}::uuid
        )
        returning "id"
      `.execute(context.transaction);

      const orderId = orderRes.rows[0]!.id;

      // 2. Insert order lines. app.order_lines.quantity is an integer, while an
      // invoice may bill 1.5 hours: a fractional line becomes one unit priced
      // at the line's subtotal, with the real quantity kept in the description,
      // so the money matches the invoice exactly. Tax uses the same rule as
      // computeInvoiceTotals (rate on the line subtotal).
      for (const line of invoiceLines) {
        const quantity = Number(line.quantity);
        const lineSubtotal = (BigInt(line.unitPriceMinor) * BigInt(Math.round(quantity * 10000))) / 10000n;
        const lineTax = (lineSubtotal * BigInt(line.taxRateBps)) / 10000n;
        const isWhole = Number.isInteger(quantity);
        await sql`
          insert into app.order_lines (
            "businessId", "orderId", "productVariantId", "description",
            "quantity", "unitPriceMinor", "discountMinor", "taxMinor",
            "lineTotalMinor", "assetCode", "selectedModifiers"
          ) values (
            ${operation.businessId}::uuid, ${orderId}::uuid, ${line.productVariantId ?? null}::uuid,
            ${isWhole ? line.description : `${line.description} (qty ${quantity})`},
            ${isWhole ? quantity : 1}, ${isWhole ? line.unitPriceMinor : lineSubtotal.toString()}::bigint, ${line.discountMinor}::bigint,
            ${lineTax.toString()}::bigint, ${line.lineTotalMinor}::bigint, ${current.currency}, '{}'::jsonb
          )
        `.execute(context.transaction);
      }

      // 3. Issue fiscal document for invoice
      const fiscalDoc = await receiptsRepo.issueInvoice(
        context,
        operation.businessId,
        orderId,
        operation.userId,
        {
          currency: current.currency,
          subtotalMinor: current.subtotalMinor,
          taxMinor: current.taxMinor,
          totalMinor: current.totalMinor,
        },
      );

      // 4. Resolve bank details for manual transfer display
      const activeAccount = await repository.findActiveVirtualAccount(context, operation.businessId);

      // 5. Update invoice
      await repository.markSent(context, operation.businessId, invoiceId, {
        orderId,
        fiscalDocumentId: fiscalDoc.id,
        invoiceNumber: fiscalDoc.number,
        payToVirtualAccountId: activeAccount?.id ?? null,
        payToBankName: activeAccount?.bankName ?? null,
        payToAccountNumber: activeAccount?.accountNumber ?? null,
        payToAccountName: activeAccount?.accountName ?? null,
      });

      return {
        invoice: await this.hydrate(context, operation.businessId, invoiceId),
        newlySent: true,
        businessName: await this.businessName(context, operation.businessId),
      };
    });

    if (newlySent && invoice.customer?.email) {
      try {
        await emailSender.sendInvoiceIssued(invoice.customer.email, {
          businessName,
          customerName: invoice.customer.name,
          invoiceNumber: invoice.invoiceNumber || "Invoice",
          amountFormatted: formatMinor(invoice.totalMinor, invoice.currency),
          dueDate: invoice.dueDate,
          payUrl: publicInvoiceUrl(invoice.publicToken),
          notes: invoice.notes,
        });
      } catch (err) {
        console.error(`[invoice] Failed to send invoice ${invoice.id} email:`, err);
      }
    }

    return invoice;
  }

  async recordPayment(
    operation: InvoiceOperation,
    invoiceId: string,
    input: RecordInvoicePaymentInput,
  ): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const invoice = await repository.find(context, operation.businessId, invoiceId);
      if (!invoice) throw notFoundError("Invoice not found");
      if (invoice.status !== "open" || !invoice.orderId) {
        throw conflictError("Payments can only be recorded on open sent invoices");
      }

      await this.paymentsService.record(
        {
          businessId: operation.businessId,
          userId: operation.userId,
          requestId: operation.requestId,
        },
        {
          orderId: invoice.orderId,
          method: input.method,
          amountMinor: Number(input.amountMinor),
          assetCode: invoice.currency,
          externalReference: input.externalReference ?? null,
          idempotencyKey: input.idempotencyKey ?? `inv_pay_${randomUUID()}`,
        },
      );

      await notifyInvoicePayment(context, invoice.orderId, String(input.amountMinor));
      return this.hydrate(context, operation.businessId, invoice.id);
    });
  }

  async void(operation: InvoiceOperation, invoiceId: string): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const invoice = await repository.find(context, operation.businessId, invoiceId);
      if (!invoice) throw notFoundError("Invoice not found");
      if (invoice.status === "void") return this.hydrate(context, operation.businessId, invoiceId);

      if (invoice.orderId) {
        const payments = await sql<{ count: string }>`
          select count(*) as count from app.payments
          where "businessId" = ${operation.businessId}::uuid and "orderId" = ${invoice.orderId}::uuid and "status" in ('captured', 'authorized')
        `.execute(context.transaction);
        if (Number(payments.rows[0]?.count ?? 0) > 0) {
          throw conflictError("Cannot void an invoice that has payments recorded against it");
        }

        // The capture webhook allocates any confirmed charge, even against a
        // cancelled order, so voiding while the customer may be mid-checkout
        // would leave a real payment on a void invoice.
        const openCheckouts = await sql<{ count: string }>`
          select count(*) as count from app.payments
          where "businessId" = ${operation.businessId}::uuid and "orderId" = ${invoice.orderId}::uuid
            and "status" = 'pending' and "method" = 'online' and "createdAt" > now() - interval '1 hour'
        `.execute(context.transaction);
        if (Number(openCheckouts.rows[0]?.count ?? 0) > 0) {
          throw conflictError("The customer started an online payment in the last hour. Try voiding again later.");
        }

        await sql`
          update app.orders
          set "status" = 'cancelled', "cancelledAt" = now()
          where "businessId" = ${operation.businessId}::uuid and "id" = ${invoice.orderId}::uuid
        `.execute(context.transaction);
      }

      await repository.markVoid(context, operation.businessId, invoiceId);
      return this.hydrate(context, operation.businessId, invoiceId);
    });
  }

  async sendReminder(
    operation: InvoiceOperation,
    invoiceId: string,
  ): Promise<{ success: boolean; lastReminderAt: string }> {
    const { invoice, businessName } = await this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const current = await repository.lockForUpdate(context, operation.businessId, invoiceId);
      if (!current) throw notFoundError("Invoice not found");
      if (current.status !== "open") {
        throw conflictError("Reminders can only be sent for open invoices");
      }

      if (current.lastReminderAt) {
        const msSinceLast = Date.now() - new Date(current.lastReminderAt).getTime();
        const oneDay = 24 * 60 * 60 * 1000;
        if (msSinceLast < oneDay) {
          throw conflictError("A reminder was already sent in the last 24 hours");
        }
      }

      const hydrated = await this.hydrate(context, operation.businessId, invoiceId);
      if (hydrated.status === "paid") throw conflictError("This invoice is already paid");
      if (!hydrated.customer?.email) throw conflictError("This customer has no email address");

      await repository.recordReminderSent(context, operation.businessId, invoiceId);
      return { invoice: hydrated, businessName: await this.businessName(context, operation.businessId) };
    });

    await emailSender.sendInvoiceReminder(invoice.customer!.email, {
      businessName,
      customerName: invoice.customer!.name,
      invoiceNumber: invoice.invoiceNumber || "Invoice",
      amountFormatted: formatMinor(invoice.balanceDueMinor, invoice.currency),
      dueDate: invoice.dueDate,
      payUrl: publicInvoiceUrl(invoice.publicToken),
      isOverdue: invoice.status === "overdue",
    });

    return { success: true, lastReminderAt: new Date().toISOString() };
  }

  /**
   * Creates a new draft from an existing invoice (any status): same customer,
   * store, currency, lines, notes and terms; issued today with the same
   * payment window. This is how a sent invoice is corrected: void it and
   * send the duplicate.
   */
  async duplicate(operation: InvoiceOperation, invoiceId: string): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");
      const source = await repository.find(context, operation.businessId, invoiceId);
      if (!source) throw notFoundError("Invoice not found");
      if (!source.customerPartyId) throw conflictError("The invoice has no customer to bill");

      const sourceLines = await repository.lines(context, operation.businessId, invoiceId);
      const lineDiscounts = sourceLines.reduce((sum, line) => sum + BigInt(line.discountMinor), 0n);
      const invoiceDiscount = BigInt(source.discountMinor) - lineDiscounts;

      const issue = dateOnly(source.issueDate);
      const due = dateOnly(source.dueDate);
      const windowDays = Math.max(0, Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${issue}T00:00:00Z`)) / 86_400_000));
      const today = await sql<{ today: string }>`select app.invoice_local_today(${source.storeId}::uuid)::text as "today"`.execute(context.transaction);
      const issueDate = today.rows[0]!.today;
      const dueDate = new Date(Date.parse(`${issueDate}T00:00:00Z`) + windowDays * 86_400_000).toISOString().slice(0, 10);

      const totals = repository.computeInvoiceTotals(
        sourceLines.map((line) => ({
          description: line.description,
          quantity: Number(line.quantity),
          unitPriceMinor: line.unitPriceMinor,
          taxRateBps: line.taxRateBps,
          discountMinor: line.discountMinor,
          productVariantId: line.productVariantId ?? undefined,
          sortOrder: line.sortOrder,
        })),
        invoiceDiscount > 0n ? invoiceDiscount : 0n,
      );
      const channelId = await repository.ensureManualInvoiceChannel(context, operation.businessId, source.storeId);
      const created = await repository.createDraft(
        context,
        operation.businessId,
        operation.userId,
        {
          storeId: source.storeId,
          channelId,
          customerPartyId: source.customerPartyId,
          issueDate,
          dueDate,
          currency: source.currency,
          notes: source.notes ?? undefined,
          terms: source.terms ?? undefined,
        },
        totals,
      );
      return this.hydrate(context, operation.businessId, created.id);
    });
  }

  /**
   * The customer says they paid by bank transfer. Nothing is marked paid:
   * the merchant is told (once per 24 hours) and records the payment when
   * the money arrives.
   */
  async reportPublicTransfer(requestId: string, token: string): Promise<{ transferReportedAt: string }> {
    return withDatabaseContext(this.database, anonymousPrincipal(requestId), async (context) => {
      const report = await repository.reportPublicTransfer(context, token);
      if (!report) throw notFoundError("Invoice not found or not awaiting payment");
      if (report.firstReport) await notifyTransferReported(context, report);
      return { transferReportedAt: new Date().toISOString() };
    });
  }

  async getPublicInvoice(requestId: string, token: string): Promise<Record<string, unknown>> {
    return withDatabaseContext(this.database, anonymousPrincipal(requestId), async (context) => {
      const publicData = await repository.findByPublicToken(context, token);
      if (!publicData) throw notFoundError("Invoice not found or link has expired");
      return publicData;
    });
  }

  /**
   * The amount is always the server-side outstanding balance and the return
   * URL is always this invoice's own page — neither comes from the caller.
   * The invoice row stays locked for the whole call, and a checkout opened in
   * the last 30 minutes for the same balance is handed back instead of
   * opening another, so a customer can't end up with two payable checkouts.
   */
  async initiatePublicPayment(
    requestId: string,
    token: string,
  ): Promise<{ authorizationUrl: string; reference: string }> {
    return withDatabaseContext(this.database, anonymousPrincipal(requestId), async (context) => {
      const target = await repository.getPublicPaymentTarget(context, token);
      if (!target) throw notFoundError("Invoice not found or link has expired");

      if (target.status !== "open" || !target.orderId) {
        throw conflictError("Invoice is not in an active payable state");
      }

      const balanceDueMinor = BigInt(target.balanceDueMinor || "0");
      if (balanceDueMinor <= 0n) {
        throw conflictError("Invoice is already paid in full");
      }

      if (target.reusableCheckoutReference && target.reusableCheckoutUrl) {
        return { authorizationUrl: target.reusableCheckoutUrl, reference: target.reusableCheckoutReference };
      }

      if (!target.customerEmail) {
        throw validationError("Customer email is required for online checkout");
      }

      // Settles to the business's own account; refused (409) when real Paystack is configured and the business has no payout account yet.
      const subaccountCode = await requireCheckoutSubaccount(context, target.businessId);

      const reference = `scripe_inv_${randomUUID().replace(/-/g, "")}`;
      const gateway = getCheckoutGateway("paystack");
      const checkout = await gateway.initializeCheckout({
        amountMinor: balanceDueMinor.toString(),
        assetCode: target.currency || "NGN",
        email: target.customerEmail,
        reference,
        callbackUrl: publicInvoiceUrl(token),
        subaccountCode,
        metadata: {
          invoiceId: target.invoiceId,
          orderId: target.orderId,
          businessId: target.businessId,
        },
      });

      const idempotencyKey = `inv_pub_${randomUUID()}`;
      await repository.recordPublicPayment(context, token, "paystack", checkout.reference, idempotencyKey, checkout.authorizationUrl);

      return {
        authorizationUrl: checkout.authorizationUrl,
        reference: checkout.reference,
      };
    });
  }

  private async hydrate(context: DatabaseContext, businessId: string, invoiceId: string): Promise<Invoice> {
    const row = await repository.findHydrated(context, businessId, invoiceId);
    if (!row) throw notFoundError("Invoice not found");
    return this.hydrateRow(context, row);
  }

  private async hydrateRow(context: DatabaseContext, row: repository.HydratedInvoiceData): Promise<Invoice> {
    const rawLines = await repository.lines(context, row.businessId, row.id);
    const lines: InvoiceLine[] = rawLines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceMinor: l.unitPriceMinor,
      taxRateBps: l.taxRateBps,
      discountMinor: l.discountMinor,
      lineTotalMinor: l.lineTotalMinor,
      productVariantId: l.productVariantId,
      sortOrder: l.sortOrder,
    }));

    const totalMinor = BigInt(row.totalMinor);
    const amountPaidMinor = BigInt(row.amountPaidMinor ?? "0");
    const balanceDueMinor = totalMinor > amountPaidMinor ? totalMinor - amountPaidMinor : 0n;

    const issueDateStr = dateOnly(row.issueDate);
    const dueDateStr = dateOnly(row.dueDate);

    // Derived in SQL (INVOICE_QUERY_CONTEXT) so list filters, metrics and this view agree; overdue uses the store's local date.
    const status = (row.derivedStatus ?? row.status) as InvoiceStatus;

    return {
      id: row.id,
      businessId: row.businessId,
      storeId: row.storeId,
      channelId: row.channelId,
      invoiceNumber: row.invoiceNumber,
      status,
      documentStatus: row.status,
      issueDate: issueDateStr,
      dueDate: dueDateStr,
      currency: row.currency,
      subtotalMinor: row.subtotalMinor,
      taxMinor: row.taxMinor,
      discountMinor: row.discountMinor,
      totalMinor: row.totalMinor,
      amountPaidMinor: amountPaidMinor.toString(),
      balanceDueMinor: balanceDueMinor.toString(),
      notes: row.notes,
      terms: row.terms,
      publicToken: row.publicToken,
      bankDetails: row.payToAccountNumber
        ? {
            bankName: row.payToBankName ?? "",
            accountNumber: row.payToAccountNumber,
            accountName: row.payToAccountName ?? "",
          }
        : null,
      customer: row.customerPartyId
        ? {
            id: row.customerPartyId,
            name: row.customerName ?? "Unknown Customer",
            email: row.customerEmail ?? "",
            phone: row.customerPhone ?? null,
          }
        : null,
      orderId: row.orderId,
      fiscalDocumentId: row.fiscalDocumentId,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
      lastReminderAt: row.lastReminderAt ? row.lastReminderAt.toISOString() : null,
      transferReportedAt: row.transferReportedAt ? row.transferReportedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lines,
    };
  }

  /** An explicit customer id wins; otherwise an existing customer with the same email is reused; otherwise a new customer is created. */
  private async resolveCustomer(
    context: DatabaseContext,
    operation: InvoiceOperation,
    customerPartyId: string | undefined,
    customer: CreateInvoiceInput["customer"],
  ): Promise<string> {
    if (customerPartyId) return customerPartyId;
    if (!customer) throw conflictError("Customer is required to create an invoice");

    const existing = await repository.findCustomerPartyByEmail(context, operation.businessId, customer.email);
    if (existing) return existing;

    const party = await partiesRepo.createParty(context, operation.businessId, operation.userId, {
      kind: "person",
      displayName: customer.name,
    });
    await partiesRepo.createCustomer(context, operation.businessId, party.id, {
      lifecycleState: "active",
    });
    await partiesRepo.createContact(context, operation.businessId, party.id, {
      kind: "email",
      value: customer.email,
      isPrimary: true,
    });
    if (customer.phone) {
      await partiesRepo.createContact(context, operation.businessId, party.id, {
        kind: "phone",
        value: customer.phone,
        isPrimary: true,
      });
    }
    if (customer.address) {
      await partiesRepo.createAddress(context, operation.businessId, party.id, {
        kind: "billing",
        line1: customer.address,
        city: customer.city ?? null,
        state: customer.state ?? null,
        countryCode: "NG",
        isDefault: true,
      });
    }
    return party.id;
  }

  private async businessName(context: DatabaseContext, businessId: string): Promise<string> {
    const res = await sql<{ displayName: string }>`
      select "displayName" from app.businesses where "id" = ${businessId}::uuid
    `.execute(context.transaction);
    return res.rows[0]?.displayName || "Merchant";
  }

  private async require(context: DatabaseContext, businessId: string, permission: string): Promise<void> {
    return authorization.requirePermission(context, businessId, permission);
  }

  private async run<T>(
    operation: InvoiceOperation,
    work: (context: DatabaseContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDatabaseContext(
        this.database,
        withIdentity(operation.requestId, operation.userId, operation.businessId),
        work,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

export async function runInvoiceOverdueSweep(
  context: DatabaseContext,
): Promise<{ remindersSent: number }> {
  const candidates = await repository.listOverdueInvoicesForSweep(context);
  let remindersSent = 0;

  for (const inv of candidates) {
    if (!inv.customerEmail) continue;
    const payUrl = publicInvoiceUrl(inv.publicToken);
    const amountFormatted = formatMinor(inv.balanceDueMinor || inv.totalMinor, inv.currency);
    const dueDateStr = dateOnly(inv.dueDate);

    try {
      await emailSender.sendInvoiceReminder(inv.customerEmail, {
        businessName: inv.businessName,
        customerName: inv.customerName,
        invoiceNumber: inv.invoiceNumber || "Invoice",
        amountFormatted,
        dueDate: dueDateStr,
        payUrl,
        isOverdue: true,
      });
      await repository.recordSweepReminderSent(context, inv.id);
      remindersSent++;
    } catch (err) {
      console.error(`[jobs] Failed to send overdue reminder for invoice ${inv.id}:`, err);
    }
  }

  return { remindersSent };
}

/**
 * node-postgres turns a `date` column into a Date at LOCAL midnight, so
 * toISOString() would print the previous day on any server east of UTC
 * (Lagos is UTC+1). Read it back with the local getters instead.
 */
function dateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}
