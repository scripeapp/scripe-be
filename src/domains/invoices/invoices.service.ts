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
import { loadEnvironment } from "../../shared/environment.js";
import { emailSender } from "../../shared/email.js";
import { getCheckoutGateway } from "../../integrations/checkout-gateway.js";
import * as authorization from "../authorization/authorization.service.js";
import * as partiesRepo from "../parties/parties.repository.js";
import type { PaymentsService } from "../payments/payments.service.js";
import * as receiptsRepo from "../receipts/receipts.repository.js";
import * as repository from "./invoices.repository.js";
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

      let customerPartyId = input.customerPartyId;
      if (!customerPartyId && input.customer) {
        const party = await partiesRepo.createParty(context, operation.businessId, operation.userId, {
          kind: "person",
          displayName: input.customer.name,
        });
        await partiesRepo.createCustomer(context, operation.businessId, party.id, {
          lifecycleState: "active",
        });
        await partiesRepo.createContact(context, operation.businessId, party.id, {
          kind: "email",
          value: input.customer.email,
          isPrimary: true,
        });
        if (input.customer.phone) {
          await partiesRepo.createContact(context, operation.businessId, party.id, {
            kind: "phone",
            value: input.customer.phone,
            isPrimary: true,
          });
        }
        if (input.customer.address) {
          await partiesRepo.createAddress(context, operation.businessId, party.id, {
            kind: "billing",
            line1: input.customer.address,
            city: input.customer.city ?? null,
            state: input.customer.state ?? null,
            countryCode: "NG",
            isDefault: true,
          });
        }
        customerPartyId = party.id;
      }

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

      let customerPartyId = input.customerPartyId;
      if (!customerPartyId && input.customer) {
        const party = await partiesRepo.createParty(context, operation.businessId, operation.userId, {
          kind: "person",
          displayName: input.customer.name,
        });
        await partiesRepo.createCustomer(context, operation.businessId, party.id, {
          lifecycleState: "active",
        });
        await partiesRepo.createContact(context, operation.businessId, party.id, {
          kind: "email",
          value: input.customer.email,
          isPrimary: true,
        });
        if (input.customer.phone) {
          await partiesRepo.createContact(context, operation.businessId, party.id, {
            kind: "phone",
            value: input.customer.phone,
            isPrimary: true,
          });
        }
        customerPartyId = party.id;
      }

      let totals: repository.ComputedInvoiceTotals | undefined;
      if (input.lines) {
        totals = repository.computeInvoiceTotals(input.lines, input.discountMinor ?? 0n);
      }

      const updated = await repository.updateDraft(
        context,
        operation.businessId,
        invoiceId,
        {
          storeId: input.storeId,
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

  async send(
    operation: InvoiceOperation,
    invoiceId: string,
  ): Promise<Invoice> {
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const invoice = await repository.lockForUpdate(context, operation.businessId, invoiceId);
      if (!invoice) throw notFoundError("Invoice not found");

      if (invoice.status === "open" && invoice.orderId && invoice.invoiceNumber) {
        return this.hydrate(context, operation.businessId, invoiceId);
      }

      if (invoice.status === "void") {
        throw conflictError("Cannot send a void invoice");
      }

      const invoiceLines = await repository.lines(context, operation.businessId, invoiceId);
      if (invoiceLines.length === 0) {
        throw conflictError("Invoice must have at least one line item before sending");
      }

      // 1. Create order
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${invoice.id.slice(0, 8).toUpperCase()}`;
      const orderRes = await sql<{ id: string }>`
        insert into app.orders (
          "businessId", "orderNumber", "storeId", "channelId", "customerPartyId",
          "currency", "status", "paymentStatus", "fulfillmentStatus",
          "subtotalMinor", "taxMinor", "discountMinor", "totalMinor", "createdBy"
        ) values (
          ${operation.businessId}::uuid, ${orderNumber}, ${invoice.storeId}::uuid, ${invoice.channelId}::uuid,
          ${invoice.customerPartyId}::uuid, ${invoice.currency}, 'placed', 'unpaid', 'unfulfilled',
          ${invoice.subtotalMinor}::bigint, ${invoice.taxMinor}::bigint, ${invoice.discountMinor}::bigint,
          ${invoice.totalMinor}::bigint, ${operation.userId}::uuid
        )
        returning "id"
      `.execute(context.transaction);

      const orderId = orderRes.rows[0]!.id;

      // 2. Insert order lines
      for (const line of invoiceLines) {
        await sql`
          insert into app.order_lines (
            "businessId", "orderId", "productVariantId", "description",
            "quantity", "unitPriceMinor", "discountMinor", "taxMinor",
            "lineTotalMinor", "assetCode", "selectedModifiers"
          ) values (
            ${operation.businessId}::uuid, ${orderId}::uuid, ${line.productVariantId ?? null}::uuid, ${line.description},
            ${Math.max(1, Math.round(Number(line.quantity)))}, ${line.unitPriceMinor}::bigint, ${line.discountMinor}::bigint,
            ${(BigInt(line.unitPriceMinor) * BigInt(line.taxRateBps)) / 10000n}::bigint,
            ${line.lineTotalMinor}::bigint, ${invoice.currency}, '{}'::jsonb
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
          currency: invoice.currency,
          subtotalMinor: invoice.subtotalMinor,
          taxMinor: invoice.taxMinor,
          totalMinor: invoice.totalMinor,
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

      const hydrated = await this.hydrate(context, operation.businessId, invoiceId);

      // Send customer notification email asynchronously (catch errors so email failure doesn't rollback commit)
      if (hydrated.customer?.email) {
        const env = loadEnvironment();
        const payUrl = `${env.FRONTEND_URL}/i/${hydrated.publicToken}`;
        const amountFormatted = `₦${(Number(hydrated.totalMinor) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        const bizRes = await sql<{ displayName: string }>`
          select "displayName" from app.businesses where "id" = ${operation.businessId}::uuid
        `.execute(context.transaction);
        const bizName = bizRes.rows[0]?.displayName || "Merchant";

        try {
          await emailSender.sendInvoiceIssued(hydrated.customer.email, {
            businessName: bizName,
            customerName: hydrated.customer.name,
            invoiceNumber: hydrated.invoiceNumber || "Invoice",
            amountFormatted,
            dueDate: hydrated.dueDate,
            payUrl,
            notes: hydrated.notes,
          });
        } catch (err) {
          console.error(`[invoice] Failed to send email to ${hydrated.customer.email}:`, err);
        }
      }

      return hydrated;
    });
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
    return this.run(operation, async (context) => {
      await this.require(context, operation.businessId, "invoice.manage");

      const invoice = await repository.find(context, operation.businessId, invoiceId);
      if (!invoice) throw notFoundError("Invoice not found");
      if (invoice.status !== "open") {
        throw conflictError("Reminders can only be sent for open invoices");
      }

      if (invoice.lastReminderAt) {
        const msSinceLast = Date.now() - new Date(invoice.lastReminderAt).getTime();
        const oneDay = 24 * 60 * 60 * 1000;
        if (msSinceLast < oneDay) {
          throw conflictError("A reminder was already sent in the last 24 hours");
        }
      }

      await repository.recordReminderSent(context, operation.businessId, invoiceId);

      // Send reminder notification email asynchronously
      const hydrated = await this.hydrate(context, operation.businessId, invoiceId);
      if (hydrated.customer?.email) {
        const env = loadEnvironment();
        const payUrl = `${env.FRONTEND_URL}/i/${hydrated.publicToken}`;
        const amountFormatted = `₦${(Number(hydrated.balanceDueMinor || hydrated.totalMinor) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        const bizRes = await sql<{ displayName: string }>`
          select "displayName" from app.businesses where "id" = ${operation.businessId}::uuid
        `.execute(context.transaction);
        const bizName = bizRes.rows[0]?.displayName || "Merchant";

        try {
          await emailSender.sendInvoiceReminder(hydrated.customer.email, {
            businessName: bizName,
            customerName: hydrated.customer.name,
            invoiceNumber: hydrated.invoiceNumber || "Invoice",
            amountFormatted,
            dueDate: hydrated.dueDate,
            payUrl,
            isOverdue: hydrated.status === "overdue",
          });
        } catch (err) {
          console.error(`[invoice] Failed to send reminder email to ${hydrated.customer.email}:`, err);
        }
      }

      return { success: true, lastReminderAt: new Date().toISOString() };
    });
  }

  async getPublicInvoice(requestId: string, token: string): Promise<Record<string, unknown>> {
    return withDatabaseContext(this.database, anonymousPrincipal(requestId), async (context) => {
      const publicData = await repository.findByPublicToken(context, token);
      if (!publicData) throw notFoundError("Invoice not found or link has expired");
      return publicData;
    });
  }

  async initiatePublicPayment(
    requestId: string,
    token: string,
    input: { callbackUrl?: string } = {},
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

      if (!target.customerEmail) {
        throw validationError("Customer email is required for online checkout");
      }

      const reference = `scripe_inv_${randomUUID().replace(/-/g, "")}`;
      const gateway = getCheckoutGateway("paystack");
      const checkout = await gateway.initializeCheckout({
        amountMinor: balanceDueMinor.toString(),
        assetCode: target.currency || "NGN",
        email: target.customerEmail,
        reference,
        callbackUrl: input.callbackUrl,
        metadata: {
          invoiceId: target.invoiceId,
          orderId: target.orderId,
          businessId: target.businessId,
          publicToken: token,
        },
      });

      const idempotencyKey = `inv_pub_${randomUUID()}`;
      await repository.recordPublicPayment(context, token, "paystack", checkout.reference, idempotencyKey);

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

    const issueDateStr = typeof row.issueDate === "string" ? row.issueDate : row.issueDate.toISOString().slice(0, 10);
    const dueDateStr = typeof row.dueDate === "string" ? row.dueDate : row.dueDate.toISOString().slice(0, 10);

    let status: InvoiceStatus;
    if (row.status === "void") {
      status = "void";
    } else if (row.status === "draft") {
      status = "draft";
    } else if (row.orderPaymentStatus === "paid" || (totalMinor > 0n && amountPaidMinor >= totalMinor)) {
      status = "paid";
    } else if (amountPaidMinor > 0n) {
      status = "partially_paid";
    } else if (new Date(dueDateStr) < new Date()) {
      status = "overdue";
    } else {
      status = "pending";
    }

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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lines,
    };
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
  const env = loadEnvironment();

  for (const inv of candidates) {
    if (!inv.customerEmail) continue;
    const payUrl = `${env.FRONTEND_URL}/i/${inv.publicToken}`;
    const amountFormatted = `₦${(Number(inv.balanceDueMinor || inv.totalMinor) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    const dueDateStr =
      typeof inv.dueDate === "string"
        ? inv.dueDate
        : (inv.dueDate as Date).toISOString().slice(0, 10);

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
