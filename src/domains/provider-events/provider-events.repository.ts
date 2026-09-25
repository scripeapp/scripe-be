import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { ProviderEventRow, RecordEventInput } from "./provider-events.types.js";

const EVENT_COLUMNS = `"id", "provider", "eventType", "providerReference", "signatureValid", "status", "payload", "errorMessage", "receivedAt", "processedAt"`;

/**
 * Idempotent on (provider, eventType, providerReference): a redelivered
 * webhook returns undefined instead of a new row, so the caller can skip
 * reprocessing it.
 */
export async function recordEvent(context: DatabaseContext, input: RecordEventInput): Promise<ProviderEventRow | undefined> {
  const result = await sql<ProviderEventRow>`
    insert into app.provider_events ("provider", "eventType", "providerReference", "signatureValid", "payload")
    values (${input.provider}, ${input.eventType}, ${input.providerReference}, ${input.signatureValid}, ${JSON.stringify(input.payload)}::jsonb)
    on conflict do nothing
    returning ${sql.raw(EVENT_COLUMNS)}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function markProcessed(context: DatabaseContext, id: string): Promise<void> {
  await sql`update app.provider_events set "status" = 'processed', "processedAt" = now() where "id" = ${id}::uuid`.execute(context.transaction);
}

export async function markIgnored(context: DatabaseContext, id: string): Promise<void> {
  await sql`update app.provider_events set "status" = 'ignored', "processedAt" = now() where "id" = ${id}::uuid`.execute(context.transaction);
}

export async function markFailed(context: DatabaseContext, id: string, errorMessage: string): Promise<void> {
  await sql`update app.provider_events set "status" = 'failed', "errorMessage" = ${errorMessage}, "processedAt" = now() where "id" = ${id}::uuid`.execute(context.transaction);
}

export interface CaptureResult {
  readonly found: boolean;
  readonly captured: boolean;
  readonly isFullyPaid: boolean;
  readonly businessId: string | null;
  readonly orderId: string | null;
  readonly amountMinor: string | null;
  readonly method: string | null;
  readonly assetCode: string | null;
  readonly orderTaxMinor: string | null;
  readonly orderTotalMinor: string | null;
}

/** Calls the SECURITY DEFINER function — the RLS bypass a webhook (no authenticated user) needs to update payments/orders. See migration 0029 for the SQL. */
export async function captureCheckoutPaymentByReference(context: DatabaseContext, externalReference: string): Promise<CaptureResult> {
  const result = await sql<CaptureResult>`select * from app.capture_checkout_payment_from_webhook(${externalReference})`.execute(context.transaction);
  return result.rows[0]!;
}

export async function failCheckoutPaymentByReference(context: DatabaseContext, externalReference: string): Promise<boolean> {
  const result = await sql<{ fail_checkout_payment_from_webhook: boolean }>`select app.fail_checkout_payment_from_webhook(${externalReference})`.execute(context.transaction);
  return result.rows[0]?.fail_checkout_payment_from_webhook ?? false;
}

export interface BankingKycReconcileResult {
  readonly found: boolean;
  readonly businessId: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly businessName: string | null;
}

export interface VirtualAccountReconcileResult {
  readonly found: boolean;
  readonly businessId: string | null;
  readonly email: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly bankName: string | null;
}

export interface WalletDepositReconcileResult {
  readonly found: boolean;
  readonly businessId: string | null;
  readonly email: string | null;
  readonly accountNumber: string | null;
  readonly bankName: string | null;
  readonly businessName: string | null;
}

export async function markBankingKycStatus(context: DatabaseContext, providerCustomerCode: string, status: "verified" | "failed", failureReason: string | null): Promise<BankingKycReconcileResult> {
  const result = await sql<BankingKycReconcileResult>`
    select * from app.mark_banking_kyc_status_from_webhook(${providerCustomerCode}, ${status}, ${failureReason})
  `.execute(context.transaction);
  return result.rows[0] ?? { found: false, businessId: null, email: null, firstName: null, businessName: null };
}

export async function markVirtualAccountStatus(
  context: DatabaseContext,
  providerAccountId: string,
  status: "active" | "failed",
  fields: { accountNumber: string | null; accountName: string | null; bankName: string | null },
): Promise<VirtualAccountReconcileResult> {
  const result = await sql<VirtualAccountReconcileResult>`
    select * from app.mark_virtual_account_status_from_webhook(${providerAccountId}, ${status}, ${fields.accountNumber}, ${fields.accountName}, ${fields.bankName})
  `.execute(context.transaction);
  return result.rows[0] ?? { found: false, businessId: null, email: null, accountNumber: null, accountName: null, bankName: null };
}

/** Returns the new receipt's id, or null if the order wasn't found or a receipt was already issued for it (idempotent via fiscal_documents' unique-per-order index). */
export async function issueReceiptFromWebhook(context: DatabaseContext, businessId: string, orderId: string): Promise<string | null> {
  const result = await sql<{ issue_receipt_from_webhook: string | null }>`
    select app.issue_receipt_from_webhook(${businessId}::uuid, ${orderId}::uuid)
  `.execute(context.transaction);
  return result.rows[0]?.issue_receipt_from_webhook ?? null;
}

export interface WebhookReconcileResult {
  readonly found: boolean;
  readonly businessId: string | null;
}

/** Looked up by the provider's own transfer id (withdrawals.providerTransferCode) — see migration 0030. */
export async function markWithdrawalStatus(context: DatabaseContext, providerTransferCode: string, status: "success" | "failed", failureReason: string | null): Promise<WebhookReconcileResult> {
  const result = await sql<WebhookReconcileResult>`
    select * from app.mark_withdrawal_status_from_webhook(${providerTransferCode}, ${status}, ${failureReason})
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function recordWalletDeposit(
  context: DatabaseContext,
  input: { provider: string; providerAccountId: string; providerReference: string; amountMinor: string; assetCode: string; description: string },
): Promise<WalletDepositReconcileResult> {
  const result = await sql<WalletDepositReconcileResult>`
    select * from app.record_wallet_deposit_from_webhook(${input.provider}, ${input.providerAccountId}, ${input.providerReference}, ${input.amountMinor}::bigint, ${input.assetCode}, ${input.description})
  `.execute(context.transaction);
  return result.rows[0] ?? { found: false, businessId: null, email: null, accountNumber: null, bankName: null, businessName: null };
}

export interface KybDocumentsForCustomer {
  readonly businessId: string;
  readonly registrationNumber: string | null;
  readonly taxIdentificationNumber: string | null;
  readonly certificateOfIncorporationKey: string | null;
  readonly certificateOfIncorporationMimeType: string | null;
  readonly statusReportKey: string | null;
  readonly statusReportMimeType: string | null;
  readonly proofOfAddressKey: string | null;
  readonly proofOfAddressMimeType: string | null;
  readonly directorIdDocumentKey: string | null;
  readonly directorIdDocumentMimeType: string | null;
}

export async function findKybDocumentsForCustomer(context: DatabaseContext, providerCustomerCode: string): Promise<KybDocumentsForCustomer | undefined> {
  const result = await sql<KybDocumentsForCustomer>`
    select * from app.banking_kyb_documents_for_customer(${providerCustomerCode})
  `.execute(context.transaction);
  return result.rows[0];
}
