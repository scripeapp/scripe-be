import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { anonymousPrincipal } from "../../db/principal.js";
import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js";
import type { JournalLineInput } from "../accounting/accounting.types.js";
import { postJournalEntry } from "../accounting/accounting.service.js";
import * as communicationsRepository from "../communications/communications.repository.js";
import * as deliveryRepository from "../delivery/delivery.repository.js";
import { handleSubscriptionWebhook } from "../subscriptions/subscriptions.service.js";
import * as repository from "./provider-events.repository.js";
import type { CaptureResult } from "./provider-events.repository.js";
import { verifyAnchorSignature, verifyBrailsSignature, verifyFlutterwaveSignature, verifyPaystackSignature, verifyShipbubbleSignature } from "./provider-events.signatures.js";
import type { ProviderName } from "./provider-events.types.js";
import { emailSender } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";

type JsonRecord = Record<string, unknown>;

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
      const result = await repository.captureCheckoutPaymentByReference(context, reference);
      if (result.captured) await this.postCaptureJournal(context, reference, result);
      if (result.captured && result.isFullyPaid && result.businessId && result.orderId) {
        await repository.issueReceiptFromWebhook(context, result.businessId, result.orderId);
      }
      return result.found ? "processed" : "ignored";
    });
    return signatureValid;
  }

  /**
   * Mirrors payments.service.ts's own (authenticated-path) capture
   * journal, since this is the same real event — a payment reaching
   * "captured" — just reached through a webhook instead of verifyCheckout.
   * Cash-method payments never arrive by webhook (a card terminal/manual
   * cash sale has no gateway to call back), so this always debits gateway
   * clearing rather than switching on method the way payments.service.ts
   * does. Tax is prorated against the order's own subtotal/tax split, the
   * remainder (rounding) folding into revenue so the entry always balances
   * exactly to amountMinor.
   */
  private async postCaptureJournal(context: DatabaseContext, reference: string, result: CaptureResult): Promise<void> {
    if (!result.businessId || !result.amountMinor || !result.assetCode) return;
    const amountMinor = BigInt(result.amountMinor);
    const totalMinor = BigInt(result.orderTotalMinor ?? "0");
    const taxMinor = BigInt(result.orderTaxMinor ?? "0");
    const taxPortion = totalMinor > 0n ? (amountMinor * taxMinor) / totalMinor : 0n;
    const revenuePortion = amountMinor - taxPortion;

    const lines: JournalLineInput[] = [{ accountCode: LEDGER_ACCOUNT_CODES.GATEWAY_CLEARING, direction: "debit", amountMinor, assetCode: result.assetCode }];
    if (revenuePortion > 0n) lines.push({ accountCode: LEDGER_ACCOUNT_CODES.REVENUE, direction: "credit" as const, amountMinor: revenuePortion, assetCode: result.assetCode });
    if (taxPortion > 0n) lines.push({ accountCode: LEDGER_ACCOUNT_CODES.TAX_PAYABLE, direction: "credit" as const, amountMinor: taxPortion, assetCode: result.assetCode });

    await postJournalEntry(context, result.businessId, null, {
      description: "Payment captured via webhook",
      sourceType: "payment_capture",
      sourceId: reference,
      lines,
    });
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
        const result = await repository.captureCheckoutPaymentByReference(context, reference);
        if (result.captured) await this.postCaptureJournal(context, reference, result);
        if (result.captured && result.isFullyPaid && result.businessId && result.orderId) {
          await repository.issueReceiptFromWebhook(context, result.businessId, result.orderId);
        }
        return result.found ? "processed" : "ignored";
      }
      const found = await repository.failCheckoutPaymentByReference(context, reference);
      return found ? "processed" : "ignored";
    });
    return signatureValid;
  }

  /**
   * Anchor's exact webhook envelope isn't confirmed against a live payload
   * in this pass (docs describe event type names but not the wrapping
   * shape) — this defensively checks a couple of plausible top-level field
   * names ("type" and "event") rather than assuming one. Verify against a
   * real sandbox delivery before relying on this in production.
   */
  async handleAnchorWebhook(rawBody: Buffer, signature: string | undefined, requestId: string): Promise<boolean> {
    const signatureValid = verifyAnchorSignature(rawBody, signature);
    const body = parseJson(rawBody);
    const resource = asRecord(body.data);
    const attributes = asRecord(resource.attributes);
    const eventType = asString(body.type) ?? asString(body.event) ?? "unknown";
    const resourceId = asString(resource.id);

    await this.ingest("anchor", eventType, resourceId, signatureValid, body, requestId, async (context) => {
      if (eventType.startsWith("customer.identification.")) {
        if (!resourceId) return "ignored";
        if (eventType === "customer.identification.approved") {
          const result = await repository.markBankingKycStatus(context, resourceId, "verified", null);
          if (result.found && result.email) {
            const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
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
          const result = await repository.markBankingKycStatus(context, resourceId, "failed", reason);
          if (result.found && result.email) {
            const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
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
        const result = await repository.markVirtualAccountStatus(context, resourceId, "active", {
          accountNumber: asString(virtualNuban.accountNumber) ?? asString(attributes.accountNumber),
          accountName: asString(attributes.accountName),
          bankName: asString(virtualNuban.bankName) ?? asString(asRecord(attributes.bank).name),
        });
        if (result.found && result.email && result.accountNumber && result.bankName) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
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
        if (result.found && result.email && result.accountNumber && result.bankName) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
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
        if (result.found && result.email && result.accountNumber && result.bankName) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
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

      try {
        const outcome = await process(context);
        if (outcome === "processed") await repository.markProcessed(context, event.id);
        else await repository.markIgnored(context, event.id);
      } catch (error) {
        await repository.markFailed(context, event.id, error instanceof Error ? error.message : String(error));
      }
    });
  }
}
