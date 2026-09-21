import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { anonymousPrincipal } from "../../db/principal.js";
import * as repository from "./provider-events.repository.js";
import { verifyAnchorSignature, verifyBrailsSignature, verifyFlutterwaveSignature, verifyPaystackSignature } from "./provider-events.signatures.js";
import type { ProviderName } from "./provider-events.types.js";

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
      if (eventType !== "charge.success" || !reference) return "ignored";
      const result = await repository.captureCheckoutPaymentByReference(context, reference);
      if (result.captured && result.isFullyPaid && result.businessId && result.orderId) {
        await repository.issueReceiptFromWebhook(context, result.businessId, result.orderId);
      }
      return result.found ? "processed" : "ignored";
    });
    return signatureValid;
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
      if (status === "successful") {
        const result = await repository.captureCheckoutPaymentByReference(context, reference);
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
          const found = await repository.markBankingKycStatus(context, resourceId, "verified", null);
          return found ? "processed" : "ignored";
        }
        if (eventType === "customer.identification.rejected" || eventType === "customer.identification.error") {
          const reason = asString(attributes.reason) ?? asString(attributes.message) ?? "KYC rejected by provider";
          const found = await repository.markBankingKycStatus(context, resourceId, "failed", reason);
          return found ? "processed" : "ignored";
        }
        return "ignored";
      }

      if (eventType === "account.opened" || eventType === "accountNumber.created") {
        if (!resourceId) return "ignored";
        const virtualNuban = asRecord(attributes.virtualNuban);
        const found = await repository.markVirtualAccountStatus(context, resourceId, "active", {
          accountNumber: asString(virtualNuban.accountNumber) ?? asString(attributes.accountNumber),
          accountName: asString(attributes.accountName),
          bankName: asString(virtualNuban.bankName) ?? asString(asRecord(attributes.bank).name),
        });
        return found ? "processed" : "ignored";
      }

      if (eventType === "account.frozen" || eventType === "account.closed") {
        if (!resourceId) return "ignored";
        const found = await repository.markVirtualAccountStatus(context, resourceId, "failed", { accountNumber: null, accountName: null, bankName: null });
        return found ? "processed" : "ignored";
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
        return result.found ? "processed" : "ignored";
      }

      // No confirmed virtual-account-status event name exists in Brails'
      // public docs, so nothing else is auto-applied here.
      return "ignored";
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
