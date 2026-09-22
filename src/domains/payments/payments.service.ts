import { randomUUID } from "node:crypto"; import type { Database } from "../../db/database.types.js"; import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js"; import { withIdentity } from "../../db/principal.js"; import { getCheckoutGateway } from "../../integrations/checkout-gateway.js"; import { notFoundError } from "../../shared/errors.js"; import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js"; import type { JournalLineInput } from "../accounting/accounting.types.js"; import { postJournalEntry } from "../accounting/accounting.service.js"; import * as authorization from "../authorization/authorization.service.js"; import * as receiptsRepo from "../receipts/receipts.repository.js"; import * as repo from "./payments.repository.js"; import type { OrderSnapshot } from "./payments.repository.js"; import type { CheckoutStatus, InitiateCheckoutInput, InitiatedCheckout, PaymentOperation, RecordPaymentInput } from "./payments.types.js";

/**
 * Shared by record() (an in-person/manual capture) and verifyCheckout() (an
 * online gateway capture) - the same real event, a payment reaching
 * "captured", reached two different ways. Tax is prorated against the
 * order's own subtotal/tax split; the rounding remainder folds into
 * revenue so the entry always balances exactly to amountMinor. "cash"
 * lands on the Cash account; every other method (card/bank_transfer/
 * online) lands on Gateway Clearing, since none of those are actually
 * swept into Surge's own bank the moment they're captured.
 */
async function postCaptureJournal(context: DatabaseContext, businessId: string, userId: string, sourceId: string, method: string, amountMinor: number | string, assetCode: string, order: OrderSnapshot): Promise<void> {
  const amount = BigInt(amountMinor);
  const totalMinor = BigInt(order.totalMinor || "0");
  const taxMinor = BigInt(order.taxMinor || "0");
  const taxPortion = totalMinor > 0n ? (amount * taxMinor) / totalMinor : 0n;
  const revenuePortion = amount - taxPortion;

  const debitAccount = method === "cash" ? LEDGER_ACCOUNT_CODES.CASH : LEDGER_ACCOUNT_CODES.GATEWAY_CLEARING;
  const lines: JournalLineInput[] = [{ accountCode: debitAccount, direction: "debit", amountMinor: amount, assetCode }];
  if (revenuePortion > 0n) lines.push({ accountCode: LEDGER_ACCOUNT_CODES.REVENUE, direction: "credit" as const, amountMinor: revenuePortion, assetCode });
  if (taxPortion > 0n) lines.push({ accountCode: LEDGER_ACCOUNT_CODES.TAX_PAYABLE, direction: "credit" as const, amountMinor: taxPortion, assetCode });

  await postJournalEntry(context, businessId, userId, { description: "Payment captured", sourceType: "payment_capture", sourceId, lines });
}

export class PaymentsService{constructor(private readonly database:Database){} async record(o:PaymentOperation,i:RecordPaymentInput){return withDatabaseContext(this.database,withIdentity(o.requestId,o.userId,o.businessId),async c=>{await authorization.requirePermission(c,o.businessId,'payment.manage');const recorded=await repo.record(c,o.businessId,o.userId,i);if(recorded.captured)await postCaptureJournal(c,o.businessId,o.userId,recorded.id,i.method,i.amountMinor,i.assetCode,recorded.order);if(recorded.isFullyPaid)await receiptsRepo.issueReceipt(c,o.businessId,i.orderId,o.userId,recorded.order);return{id:recorded.id};});}

  /**
   * Sends the customer to the gateway's hosted checkout page. Records the
   * payment as "pending" immediately (repo.record with status "pending"
   * never allocates or trips fully-paid) so the pending attempt is visible
   * on the order right away; verifyCheckout is what actually captures it.
   */
  async initiateCheckout(operation: PaymentOperation, input: InitiateCheckoutInput): Promise<InitiatedCheckout> {
    return withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), async (context) => {
      await authorization.requirePermission(context, operation.businessId, "payment.manage");

      const reference = `surge_${randomUUID()}`;
      const gateway = getCheckoutGateway(input.gateway);
      const checkout = await gateway.initializeCheckout({
        amountMinor: String(input.amountMinor),
        assetCode: input.assetCode,
        email: input.email,
        reference,
        callbackUrl: input.callbackUrl,
        metadata: { orderId: input.orderId, businessId: operation.businessId },
      });

      const recorded = await repo.record(context, operation.businessId, operation.userId, {
        orderId: input.orderId,
        method: "online",
        assetCode: input.assetCode,
        amountMinor: input.amountMinor,
        status: "pending",
        externalReference: checkout.reference,
        idempotencyKey: input.idempotencyKey,
      });
      await repo.createAttempt(context, operation.businessId, recorded.id, input.gateway, checkout.reference);

      return { paymentId: recorded.id, authorizationUrl: checkout.authorizationUrl, reference: checkout.reference };
    });
  }

  /**
   * Confirms with the gateway whether a checkout actually succeeded, then
   * captures (allocates + maybe issues a receipt) or fails the payment
   * accordingly. Safe to call more than once for the same reference —
   * repo.captureCheckoutPayment only allocates while the payment is still
   * "pending".
   */
  async verifyCheckout(operation: PaymentOperation, reference: string): Promise<CheckoutStatus> {
    return withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), async (context) => {
      await authorization.requirePermission(context, operation.businessId, "payment.manage");

      const attempt = await repo.findAttemptByReference(context, operation.businessId, reference);
      const payment = await repo.findPaymentByExternalReference(context, operation.businessId, reference);
      if (!attempt || !payment) throw notFoundError("Checkout not found");
      if (payment.status !== "pending") return { status: payment.status === "captured" ? "captured" : "failed" };

      const gateway = getCheckoutGateway(attempt.provider as "paystack" | "flutterwave");
      const verification = await gateway.verifyCheckout(reference);

      if (verification.status === "success") {
        const captured = await repo.captureCheckoutPayment(context, operation.businessId, payment.id);
        await repo.markAttempt(context, operation.businessId, reference, "captured", null);
        if (captured?.captured) await postCaptureJournal(context, operation.businessId, operation.userId, payment.id, captured.method, captured.amountMinor, captured.order.currency, captured.order);
        if (captured?.isFullyPaid) await receiptsRepo.issueReceipt(context, operation.businessId, payment.orderId, operation.userId, captured.order);
        return { status: "captured", isFullyPaid: captured?.isFullyPaid ?? false };
      }

      if (verification.status === "failed") {
        await repo.markCheckoutPaymentFailed(context, operation.businessId, payment.id);
        await repo.markAttempt(context, operation.businessId, reference, "failed", verification.failureReason);
        return { status: "failed" };
      }

      return { status: "pending" };
    });
  }
}
