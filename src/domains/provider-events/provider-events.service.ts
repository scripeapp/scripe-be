import * as notificationsRepository from "../notifications/notifications.repository.js";
import { sql } from "kysely";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { anonymousPrincipal } from "../../db/principal.js";
import * as communicationsRepository from "../communications/communications.repository.js";
import * as deliveryRepository from "../delivery/delivery.repository.js";
import { handleSubscriptionWebhook } from "../subscriptions/subscriptions.service.js";
import { settleCheckoutPayment } from "./checkout-settlement.js";
import * as repository from "./provider-events.repository.js";
import { verifyAnchorSignature, verifyBrailsSignature, verifyFlutterwaveSignature, verifyPaystackSignature, verifyShipbubbleSignature } from "./provider-events.signatures.js";
import type { ProviderName } from "./provider-events.types.js";
import { emailSender } from "../../shared/email.js";
import { paymentProvider, type BusinessDocument } from "../../integrations/payment-provider.js";
import { objectStorage } from "../../integrations/r2.js";
import { loadEnvironment } from "../../shared/environment.js";

type JsonRecord = Record<string, unknown>;

function toBusinessDocuments(rows: readonly repository.KybDocumentsForCustomerRow[]): BusinessDocument[] {
  const documents: BusinessDocument[] = [];
  const first = rows[0];
  if (!first) return documents;

  if (first.registrationNumber) {
    documents.push({ documentType: "RC_NUMBER", text: first.registrationNumber });
    documents.push({ documentType: "BN_NUMBER", text: first.registrationNumber });
  }
  if (first.taxIdentificationNumber) {
    documents.push({ documentType: "TIN", text: first.taxIdentificationNumber });
  }

  for (const row of rows) {
    if (row.documentType && row.objectKey) {
      const key = row.objectKey;
      const mimeType = row.mimeType ?? "application/octet-stream";
      const docType = row.documentType;
      documents.push({
        documentType: docType,
        file: {
          mimeType,
          fileName: key.split("/").pop() ?? docType,
          load: () => objectStorage.getObjectBytes(key),
        },
      });
      if (docType === "CAC_STATUS_REPORT") {
        documents.push({
          documentType: "MEMORANDUM_OF_ASSOCIATION",
          file: {
            mimeType,
            fileName: key.split("/").pop() ?? "MEMORANDUM_OF_ASSOCIATION",
            load: () => objectStorage.getObjectBytes(key),
          },
        });
      }
    }
  }

  return documents;
}

function parseJson(rawBody: Buffer): JsonRecord {
  return JSON.parse(rawBody.toString("utf8")) as JsonRecord;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Both providers' amount fields are already integer minor units (kobo) by convention elsewhere in this integration — accepts either a JSON number or a numeric string, never silently truncates a fraction. */
function numericToMinorString(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

export class ProviderEventsService {
  constructor(private readonly database: Database) {}

  async handlePaystackWebhook(rawBody: Buffer, signature: string | undefined, requestId: string): Promise<boolean> {
    const signatureValid = verifyPaystackSignature(rawBody, signature);
    const body = parseJson(rawBody);
    const data = asRecord(body.data);
    const eventType = asString(body.event) ?? "unknown";
    const reference = asString(data.reference);

    await this.ingest("paystack", eventType, reference, signatureValid, body, requestId, async (context) => {
      // Subscription lifecycle events (subscription.create/enable/disable/
      // not_renew, invoice.payment_failed) are keyed by subscription_code,
      // not a reference - some carry no reference at all, so this must be
      // checked before the reference-based branches below, mirroring
      // legacy's classifyPaystackEvent (metadata.transaction_type, a
      // subscription_code, or a "subscription."-prefixed event type).
      const metadata = asRecord(data.metadata);
      const isSubscriptionEvent =
        asString(metadata.transaction_type) === "business_subscription" || Boolean(asString(data.subscription_code)) || eventType.startsWith("subscription.") || eventType === "invoice.payment_failed";
      if (isSubscriptionEvent) return this.handleSubscriptionPaystackEvent(context, eventType, data, metadata);

      if (!reference) return "ignored";
      if (reference.startsWith("comm_credit_")) return this.handleCommunicationTopupReference(context, eventType === "charge.success", reference);
      if (eventType !== "charge.success") return "ignored";
      const outcome = await settleCheckoutPayment(context, reference, { amountMinor: numericToMinorString(data.amount), currency: asString(data.currency) });
      return outcome.status === "not_found" ? "ignored" : "processed";
    });
    return signatureValid;
  }

  private async handleSubscriptionPaystackEvent(context: DatabaseContext, eventType: string, data: JsonRecord, metadata: JsonRecord): Promise<"processed" | "ignored"> {
    const businessId = asString(metadata.business_id);
    if (!businessId) return "ignored";
    const plan = asString(metadata.plan);
    const planCode = plan === "plus" || plan === "pro" ? plan : null;
    const customer = asRecord(data.customer);
    const planData = asRecord(data.plan);
    const periodEndRaw = asString(data.next_payment_date) ?? asString(metadata.next_payment_date);

    return handleSubscriptionWebhook(context, {
      type: eventType,
      businessId,
      planCode: planCode ?? (asString(planData.plan_code) ? planCode : null),
      subscriptionCode: asString(data.subscription_code),
      customerCode: asString(customer.customer_code),
      emailToken: asString(data.email_token),
      periodEnd: periodEndRaw ? new Date(periodEndRaw) : null,
      amountMinor: typeof data.amount === "number" ? data.amount : null,
      providerReference: asString(data.reference),
    });
  }

  /** Both checkout gateways route a communication-credit top-up here by its "comm_credit_" reference prefix rather than through the order/payment capture path above, which owns a structurally different concern (allocating against an order's total, issuing a receipt). */
  private async handleCommunicationTopupReference(context: DatabaseContext, succeeded: boolean, reference: string): Promise<"processed" | "ignored"> {
    if (!succeeded) {
      const found = await communicationsRepository.failTopupByReference(context, reference);
      return found ? "processed" : "ignored";
    }
    const result = await communicationsRepository.completeTopupByReference(context, reference);
    return result.found ? "processed" : "ignored";
  }

  async handleFlutterwaveWebhook(rawBody: Buffer, signature: string | undefined, requestId: string): Promise<boolean> {
    const signatureValid = verifyFlutterwaveSignature(signature);
    const body = parseJson(rawBody);
    const data = asRecord(body.data);
    const eventType = asString(body.event) ?? "unknown";
    const reference = asString(data.tx_ref);
    const status = asString(data.status);

    await this.ingest("flutterwave", eventType, reference, signatureValid, body, requestId, async (context) => {
      if (eventType !== "charge.completed" || !reference) return "ignored";
      if (reference.startsWith("comm_credit_")) return this.handleCommunicationTopupReference(context, status === "successful", reference);
      if (status === "successful") {
        // Flutterwave reports major units (naira); payments are stored in kobo.
        const amountMajor = typeof data.amount === "number" ? data.amount : Number(asString(data.amount) ?? NaN);
        const amountMinor = Number.isFinite(amountMajor) && amountMajor > 0 ? String(Math.round(amountMajor * 100)) : null;
        const outcome = await settleCheckoutPayment(context, reference, { amountMinor, currency: asString(data.currency) });
        return outcome.status === "not_found" ? "ignored" : "processed";
      }
      const found = await repository.failCheckoutPaymentByReference(context, reference);
      return found ? "processed" : "ignored";
    });
    return signatureValid;
  }

  /**
   * Anchor's envelope (https://docs.getanchor.co/docs/webhooks-overview):
   * `data` is the Event itself — `data.id` is the event's own id and
   * `data.type` the event type — and what it is about sits under
   * `data.relationships` (e.g. relationships.customer.data.id). Attributes
   * are minimal unless the webhook was created with supportIncluded.
   * Events other than customer.identification.* still read `data.id` as
   * their subject and must be checked against real sandbox deliveries
   * (every payload is kept in provider_events).
   */
  async handleAnchorWebhook(rawBody: Buffer, signature: string | undefined, requestId: string): Promise<boolean> {
    const signatureValid = verifyAnchorSignature(rawBody, signature);
    const body = parseJson(rawBody);
    const resource = asRecord(body.data);
    const attributes = asRecord(resource.attributes);
    const eventType = asString(resource.type) ?? asString(body.type) ?? asString(body.event) ?? "unknown";
    const resourceId = asString(resource.id);
    const relationshipId = (name: string) => asString(asRecord(asRecord(asRecord(resource.relationships)[name]).data).id);

    await this.ingest("anchor", eventType, resourceId, signatureValid, body, requestId, async (context) => {
      if (eventType.startsWith("customer.identification.")) {
        const customerId = relationshipId("customer");
        if (!customerId) return "ignored";
        if (eventType === "customer.identification.awaitingDocument") {
          const stored = await repository.findKybDocumentsForCustomer(context, customerId);
          if (!stored || stored.length === 0) return "ignored";
          const result = await paymentProvider.submitBusinessDocuments({ customerCode: customerId, documents: toBusinessDocuments(stored) });
          if (result.missing.length > 0) console.warn(`Anchor requested KYB documents we don't hold for ${stored[0]?.businessId}:`, result.missing);
          return "processed";
        }
        if (eventType === "customer.identification.approved") {
          const result = await repository.markBankingKycStatus(context, customerId, "verified", null);
          if (result.found && result.email) {
            const frontendUrl = loadEnvironment().FRONTEND_URL || "https://scripe.app";
            void emailSender.sendBankingKybApproved(result.email, {
              businessName: result.businessName || "your business",
              directorName: result.firstName || "Director",
              dashboardUrl: `${frontendUrl}/dashboard/banking`,
            }).catch((err) => console.warn("Failed to dispatch KYC approved email:", err));
          }
          return result.found ? "processed" : "ignored";
        }
        if (eventType === "customer.identification.rejected" || eventType === "customer.identification.error") {
          const reason = asString(attributes.reason) ?? asString(attributes.message) ?? "KYC rejected by provider";
          const result = await repository.markBankingKycStatus(context, customerId, "failed", reason);
          if (result.found && result.email) {
            const frontendUrl = loadEnvironment().FRONTEND_URL || "https://scripe.app";
            void emailSender.sendBankingKybFailed(result.email, {
              businessName: result.businessName || "your business",
              directorName: result.firstName || "Director",
              reason,
              retryUrl: `${frontendUrl}/dashboard/banking`,
            }).catch((err) => console.warn("Failed to dispatch KYC rejected email:", err));
          }
          return result.found ? "processed" : "ignored";
        }
        return "ignored";
      }

      if (eventType === "account.opened" || eventType === "accountNumber.created") {
        if (!resourceId) return "ignored";
        const virtualNuban = asRecord(attributes.virtualNuban);
        let candidateAccountNumber = asString(virtualNuban.accountNumber) ?? asString(attributes.accountNumber);
        if (candidateAccountNumber && candidateAccountNumber.includes("*")) {
          candidateAccountNumber = null;
        }
        const result = await repository.markVirtualAccountStatus(context, resourceId, "active", {
          accountNumber: candidateAccountNumber,
          accountName: asString(attributes.accountName),
          bankName: asString(virtualNuban.bankName) ?? asString(asRecord(attributes.bank).name),
        });
        if (result.found && result.email && result.accountNumber && result.bankName) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://scripe.app";
          void emailSender.sendVirtualAccountIssued(result.email, {
            businessName: result.accountName || "your business",
            accountNumber: result.accountNumber,
            accountName: result.accountName || "your business",
            bankName: result.bankName,
            dashboardUrl: `${frontendUrl}/dashboard/banking`,
          }).catch((err) => console.warn("Failed to dispatch virtual account issued email:", err));
        }
        return result.found ? "processed" : "ignored";
      }

      if (eventType === "account.frozen" || eventType === "account.closed") {
        if (!resourceId) return "ignored";
        const result = await repository.markVirtualAccountStatus(context, resourceId, "failed", { accountNumber: null, accountName: null, bankName: null });
        return result.found ? "processed" : "ignored";
      }

      if (eventType.startsWith("nip.transfer.")) {
        if (!resourceId) return "ignored";
        const status = eventType === "nip.transfer.successful" ? "success" : eventType === "nip.transfer.failed" || eventType === "nip.transfer.reversed" ? "failed" : null;
        // nip.transfer.initiated (and inbound nip.inbound.*) have no
        // terminal state to reconcile against yet.
        if (!status) return "ignored";
        const reason = asString(attributes.reason) ?? asString(attributes.message);
        const result = await repository.markWithdrawalStatus(context, resourceId, status, reason);
        return result.found ? "processed" : "ignored";
      }

      if (eventType === "payment.received" || eventType === "payin.received") {
        // Best-effort reading of Anchor's {data:{id,attributes}} shape for
        // a deposit event — not confirmed against a live payload. Verify
        // field names against a real sandbox delivery before trusting
        // this in production.
        const accountRelationship = asRecord(asRecord(resource.relationships).account);
        const accountData = asRecord(accountRelationship.data);
        const providerAccountId = asString(accountData.id) ?? asString(attributes.accountId);
        const amountMinor = numericToMinorString(attributes.amount);
        if (!providerAccountId || !amountMinor || !resourceId) return "ignored";
        const result = await repository.recordWalletDeposit(context, {
          provider: "anchor",
          providerAccountId,
          providerReference: resourceId,
          amountMinor,
          assetCode: asString(attributes.currency) ?? "NGN",
          description: "Virtual account deposit",
        });
        if (result.found && result.email && result.accountNumber && result.bankName && (await notificationsRepository.wantsEmail(context, result.email, "deposits"))) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://scripe.app";
          const amountFormatted = `₦${(Number(amountMinor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
          void emailSender.sendVirtualAccountDeposit(result.email, {
            businessName: result.businessName || "your business",
            amountFormatted,
            accountNumber: result.accountNumber,
            bankName: result.bankName,
            dashboardUrl: `${frontendUrl}/dashboard/banking`,
          }).catch((err) => console.warn("Failed to dispatch deposit received email:", err));
        }
        return result.found ? "processed" : "ignored";
      }

      return "ignored";
    });
    return signatureValid;
  }

  async handleBrailsWebhook(rawBody: Buffer, signature: string | undefined, requestId: string): Promise<boolean> {
    const signatureValid = verifyBrailsSignature(rawBody, signature);
    const body = parseJson(rawBody);
    const data = asRecord(body.data);
    const eventType = asString(body.event) ?? "unknown";
    const reference = asString(data.reference) ?? asString(data.id);

    await this.ingest("brails", eventType, reference, signatureValid, body, requestId, async (context) => {
      if (eventType === "payout.transfer.success" || eventType === "payout.transfer.failed") {
        const transferCode = asString(data.id);
        if (!transferCode) return "ignored";
        const status = eventType === "payout.transfer.success" ? "success" : "failed";
        const reason = asString(data.reason) ?? asString(data.message);
        const result = await repository.markWithdrawalStatus(context, transferCode, status, reason);
        return result.found ? "processed" : "ignored";
      }

      if (eventType === "transaction.deposit.success") {
        // Best-effort reading given only the {event,data} envelope is
        // confirmed in Brails' public docs, not this event's exact field
        // names — verify against a real sandbox delivery before trusting
        // this in production.
        const providerAccountId = asString(data.accountId) ?? asString(data.virtualAccountId) ?? asString(data.id);
        const amountMinor = numericToMinorString(data.amount);
        const depositReference = asString(data.reference) ?? asString(data.id);
        if (!providerAccountId || !amountMinor || !depositReference) return "ignored";
        const result = await repository.recordWalletDeposit(context, {
          provider: "brails",
          providerAccountId,
          providerReference: depositReference,
          amountMinor,
          assetCode: asString(data.currency) ?? "NGN",
          description: "Virtual account deposit",
        });
        if (result.found && result.email && result.accountNumber && result.bankName && (await notificationsRepository.wantsEmail(context, result.email, "deposits"))) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://scripe.app";
          const amountFormatted = `₦${(Number(amountMinor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
          void emailSender.sendVirtualAccountDeposit(result.email, {
            businessName: result.businessName || "your business",
            amountFormatted,
            accountNumber: result.accountNumber,
            bankName: result.bankName,
            dashboardUrl: `${frontendUrl}/dashboard/banking`,
          }).catch((err) => console.warn("Failed to dispatch deposit received email:", err));
        }
        return result.found ? "processed" : "ignored";
      }

      // No confirmed virtual-account-status event name exists in Brails'
      // public docs, so nothing else is auto-applied here.
      return "ignored";
    });
    return signatureValid;
  }

  /** Shipbubble's shipment.status.changed event, mapped to app.deliveries' status vocabulary (pending/booked/in_transit/delivered/failed/cancelled) - not the order-shipping-status vocabulary legacy used, since this only touches the delivery record, not the order. */
  async handleShipbubbleWebhook(rawBody: Buffer, signature: string | undefined, requestId: string): Promise<boolean> {
    const signatureValid = verifyShipbubbleSignature(rawBody, signature);
    const body = parseJson(rawBody);
    const eventType = asString(body.event) ?? "unknown";
    const trackingCode = asString(body.order_id);
    const shipStatus = asString(body.status);
    const courier = asRecord(body.courier);

    await this.ingest("shipbubble", eventType, trackingCode, signatureValid, body, requestId, async (context) => {
      if (eventType !== "shipment.status.changed" || !trackingCode || !shipStatus) return "ignored";
      const statusMap: Record<string, "pending" | "booked" | "in_transit" | "delivered" | "cancelled"> = {
        pending: "pending",
        confirmed: "booked",
        picked_up: "in_transit",
        in_transit: "in_transit",
        out_for_delivery: "in_transit",
        completed: "delivered",
        cancelled: "cancelled",
      };
      const mappedStatus = statusMap[shipStatus];
      if (!mappedStatus) return "ignored";

      const result = await deliveryRepository.updateFromWebhookByTrackingCode(context, trackingCode, mappedStatus, {
        location: asString(courier.name) ?? "",
        message: `Status changed to ${shipStatus}`,
        captured: new Date().toISOString(),
      });
      return result.found ? "processed" : "ignored";
    });
    return signatureValid;
  }

  private async ingest(
    provider: ProviderName,
    eventType: string,
    providerReference: string | null,
    signatureValid: boolean,
    payload: JsonRecord,
    requestId: string,
    process: (context: DatabaseContext) => Promise<"processed" | "ignored">,
  ): Promise<void> {
    await withDatabaseContext(this.database, anonymousPrincipal(requestId), async (context) => {
      const event = await repository.recordEvent(context, { provider, eventType, providerReference, signatureValid, payload });
      // undefined means a redelivery of an event already logged — the
      // dedupe index caught it, nothing left to do.
      if (!event) return;
      if (!signatureValid) {
        await repository.markFailed(context, event.id, "Signature verification failed");
        return;
      }

      // A database error inside `process` aborts the transaction; rolling
      // back to this savepoint keeps the logged event so it can be marked
      // failed with the reason, instead of the whole delivery 500ing and
      // leaving no trace.
      await sql`savepoint provider_event_process`.execute(context.transaction);
      try {
        const outcome = await process(context);
        await sql`release savepoint provider_event_process`.execute(context.transaction);
        if (outcome === "processed") await repository.markProcessed(context, event.id);
        else await repository.markIgnored(context, event.id);
      } catch (error) {
        await sql`rollback to savepoint provider_event_process`.execute(context.transaction);
        await repository.markFailed(context, event.id, error instanceof Error ? error.message : String(error));
      }
    });
  }
}
