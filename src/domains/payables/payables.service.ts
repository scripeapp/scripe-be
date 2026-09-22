/**
 * Business workflows and transaction boundaries for the bill, bill line, and bill
 * payment allocation domain belong here.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js"; import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js"; import { withIdentity } from "../../db/principal.js"; import type { ApprovalsService } from "../approvals/approvals.service.js"; import * as authorizationRepository from "../authorization/authorization.repository.js"; import * as authorization from "../authorization/authorization.service.js"; import { notFoundError, validationError } from "../../shared/errors.js"; import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js"; import type { JournalLineInput } from "../accounting/accounting.types.js"; import { postJournalEntry, resolveExpenseAccountCode } from "../accounting/accounting.service.js"; import * as repo from "./payables.repository.js"; import type { AllocatePaymentInput, AllocatePaymentResult, BillLineInput, CreateBillInput, PayablesOperation } from "./payables.types.js";

/**
 * Bills go straight from "draft" (createBill's only reachable status - see
 * migration 0017: nothing in this domain ever transitions a bill to
 * "approved") to partially_paid/paid via allocatePayment, so bill creation
 * is the only point ever actually reached where a liability could be
 * recognized - this posts here, not at some unused "approved" step. Lines
 * are grouped by their resolved ledger account (accountCategory, falling
 * back to the bill's billType, falling back to general_expense) and
 * summed from the lines themselves rather than trusted bill-level
 * subtotal/tax/total fields, which createBill never cross-validates
 * against each other - this way the journal always balances by
 * construction regardless of whether the caller's totals reconcile.
 */
async function postBillCreatedJournal(context: DatabaseContext, businessId: string, userId: string, billId: string, billType: string, assetCode: string, lines: readonly BillLineInput[]): Promise<void> {
  const expenseTotals = new Map<string, bigint>();
  let taxTotal = 0n;
  for (const line of lines) {
    const accountCode = resolveExpenseAccountCode(line.accountCategory, billType);
    expenseTotals.set(accountCode, (expenseTotals.get(accountCode) ?? 0n) + BigInt(line.lineTotalMinor));
    taxTotal += BigInt(line.taxMinor ?? 0);
  }

  const journalLines: JournalLineInput[] = [...expenseTotals.entries()].map(([accountCode, amountMinor]) => ({ accountCode, direction: "debit", amountMinor, assetCode }));
  if (taxTotal > 0n) journalLines.push({ accountCode: LEDGER_ACCOUNT_CODES.TAX_EXPENSE, direction: "debit", amountMinor: taxTotal, assetCode });
  const totalMinor = journalLines.reduce((sum, line) => sum + line.amountMinor, 0n);
  if (totalMinor === 0n) return;
  journalLines.push({ accountCode: LEDGER_ACCOUNT_CODES.ACCOUNTS_PAYABLE, direction: "credit", amountMinor: totalMinor, assetCode });

  await postJournalEntry(context, businessId, userId, { description: "Bill recorded", sourceType: "bill", sourceId: billId, lines: journalLines });
}

/** Settles the liability bill creation recognized. Always credits "bank" - a bill payment allocation only ever records a payment already made externally (no gateway/wallet call happens anywhere in this domain), never a cash-register sale. */
async function postBillPaymentJournal(context: DatabaseContext, businessId: string, userId: string, allocationId: string, amountMinor: number, assetCode: string): Promise<void> {
  await postJournalEntry(context, businessId, userId, {
    description: "Bill payment recorded",
    sourceType: "bill_payment_allocation",
    sourceId: allocationId,
    lines: [
      { accountCode: LEDGER_ACCOUNT_CODES.ACCOUNTS_PAYABLE, direction: "debit", amountMinor: BigInt(amountMinor), assetCode },
      { accountCode: LEDGER_ACCOUNT_CODES.BANK, direction: "credit", amountMinor: BigInt(amountMinor), assetCode },
    ],
  });
}

export class PayablesService {
  constructor(
    private readonly database: Database,
    private readonly approvals: ApprovalsService,
  ) {}

  async createBill(o: PayablesOperation, input: CreateBillInput) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "payables.manage");
      const bill = await repo.createBill(c, o.businessId, o.userId, input);
      await postBillCreatedJournal(c, o.businessId, o.userId, bill.id, input.billType ?? "supplier", input.assetCode ?? "NGN", input.lines);
      return bill;
    });
  }

  /**
   * next's payables domain has no real wallet-disbursement flow — this
   * just records that a payment already made externally happened. Gating
   * it means requiring approval before that record is written, not before
   * money moves (nothing here moves money). See migration 0031's header
   * comment for why bill-payment gating means this and not a disbursement
   * gate the way legacy's bill_transfer gating did.
   */
  async allocatePayment(o: PayablesOperation, billId: string, input: AllocatePaymentInput): Promise<AllocatePaymentResult> {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "payables.manage");

      const bill = await repo.findBillForAllocation(c, o.businessId, billId);
      if (!bill) throw notFoundError("Bill not found");
      if (bill.status === "voided") throw validationError("Bill is voided");
      if (bill.assetCode !== input.assetCode) throw validationError("Payment currency differs from the bill's currency");
      if (BigInt(bill.amountPaidMinor) + BigInt(input.amountMinor) > BigInt(bill.totalMinor)) throw validationError("Payment exceeds the bill's remaining balance");

      const membership = await authorizationRepository.findMembershipByUserId(c, o.businessId, o.userId);
      const isOwner = membership?.roles.some((role) => role.code === "owner") ?? false;

      const allocationId = randomUUID();
      const gate = await this.approvals.gateSubmission(c, o.businessId, "bill_payment", {
        subjectType: "bill_payment",
        subjectId: allocationId,
        amountMinor: String(input.amountMinor),
        assetCode: input.assetCode,
        requestedBy: o.userId,
        requestedByEmail: membership?.email ?? "",
        requestedByIsOwner: isOwner,
        pendingPayload: { billId, paymentReference: input.paymentReference, amountMinor: input.amountMinor, assetCode: input.assetCode, paidAt: input.paidAt ?? null },
      });
      if (gate.gated) return { gated: true, approvalRequestId: gate.requestId };

      const result = await repo.allocatePayment(c, o.businessId, o.userId, billId, input, allocationId);
      if (!result) throw new Error("Payment exceeds balance, currency differs, bill is missing, or payment reference is already used");
      await postBillPaymentJournal(c, o.businessId, o.userId, result.id, input.amountMinor, input.assetCode);
      return { gated: false, id: result.id };
    });
  }

  /**
   * Called once a gated bill-payment allocation's approval_requests row
   * reaches a terminal state — dispatched from approvals.controller.ts,
   * not from within approvals.service.ts, to avoid a circular import
   * (payables needs to call approvals to gate; approvals would need to
   * call payables to finalize). On approval, this is the first time the
   * allocation row is actually written — nothing existed before now.
   */
  async finalizeGatedPayment(o: PayablesOperation, outcome: "approved" | "rejected", requestedBy: string | null, pendingPayload: Record<string, unknown> | null): Promise<void> {
    if (outcome === "rejected" || !pendingPayload) return; // nothing was ever written for a gated allocation, so there's nothing to reverse
    return this.run(o, async (c) => {
      const billId = String(pendingPayload.billId);
      const input: AllocatePaymentInput = {
        paymentReference: String(pendingPayload.paymentReference),
        amountMinor: Number(pendingPayload.amountMinor),
        assetCode: String(pendingPayload.assetCode),
        paidAt: typeof pendingPayload.paidAt === "string" ? pendingPayload.paidAt : undefined,
      };
      const result = await repo.allocatePayment(c, o.businessId, requestedBy ?? o.userId, billId, input);
      if (!result) throw new Error("Could not record the approved bill payment — the bill may have changed since it was submitted for approval");
      await postBillPaymentJournal(c, o.businessId, requestedBy ?? o.userId, result.id, input.amountMinor, input.assetCode);
    });
  }

  private run<T>(o: PayablesOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { return withDatabaseContext(this.database, withIdentity(o.requestId, o.userId, o.businessId), work); }
}
