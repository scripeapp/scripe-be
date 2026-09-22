/**
 * Transfers domain workflows and transaction boundaries: the canonical
 * outbound money-movement engine every merchant workflow reuses (wallet
 * withdrawals, supplier payments, payroll) instead of growing its own payout
 * table (PROPOSED_TABLE_INVENTORY.md sections 9 and 11).
 *
 * Boundaries intentionally kept outside this engine for this slice:
 *   * Approval gating and the balanced journal posting are the responsibility
 *     of the workflow that raises the transfer (payables gates and posts a
 *     bill payment; payroll gates and posts a run). Folding this engine under
 *     banking.withdrawals (Path A, step 8) repoints the approvals dispatch and
 *     supplies the wallet source account then. `journalEntryId` is the
 *     nullable linkage point a caller sets once it has posted.
 *   * The provider call runs inside the request transaction, matching the
 *     shipped banking withdrawal flow's established convention in this
 *     codebase; a retry/outbox split is a later change tracked with banking.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { paymentProvider } from "../../integrations/payment-provider.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import * as businessesRepository from "../businesses/businesses.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./transfers.repository.js";
import type {
  Beneficiary,
  BeneficiaryRow,
  CreateBeneficiaryInput,
  RequestTransferInput,
  Transfer,
  TransferAttemptRow,
  TransferRow,
  TransfersOperation,
  TransferStatus,
} from "./transfers.types.js";

const DEFAULT_ASSET_CODE = "NGN";

export class TransfersService {
  constructor(private readonly database: Database) {}

  async listBeneficiaries(operation: TransfersOperation): Promise<Beneficiary[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.read");
      return (await repository.listBeneficiaries(context, operation.businessId)).map(toBeneficiary);
    });
  }

  async getBeneficiary(operation: TransfersOperation, beneficiaryId: string): Promise<Beneficiary> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.read");
      const row = await repository.findBeneficiary(context, operation.businessId, beneficiaryId);
      if (!row) throw notFoundError("Beneficiary not found");
      return toBeneficiary(row);
    });
  }

  async createBeneficiary(operation: TransfersOperation, input: CreateBeneficiaryInput): Promise<Beneficiary> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.manage");
      // Same bank coordinates are one beneficiary per business; re-adding an
      // existing (even archived) destination returns it rather than colliding
      // on the unique constraint.
      const existing = await repository.findBeneficiaryByCoordinates(context, operation.businessId, input.bankCode, input.accountNumber);
      if (existing) return toBeneficiary(existing);
      const row = await repository.insertBeneficiary(context, operation.businessId, {
        kind: input.kind,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        partyId: input.partyId ?? null,
      });
      return toBeneficiary(row);
    });
  }

  async archiveBeneficiary(operation: TransfersOperation, beneficiaryId: string): Promise<Beneficiary> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.manage");
      const row = await repository.setBeneficiaryStatus(context, operation.businessId, beneficiaryId, "archived");
      if (!row) throw notFoundError("Beneficiary not found");
      return toBeneficiary(row);
    });
  }

  async listTransfers(operation: TransfersOperation, status: TransferStatus | undefined, limit: number): Promise<Transfer[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.read");
      const rows = await repository.listTransfers(context, operation.businessId, status, limit);
      return Promise.all(rows.map((row) => this.hydrate(context, operation.businessId, row)));
    });
  }

  async getTransfer(operation: TransfersOperation, transferId: string): Promise<Transfer> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.read");
      const row = await repository.findTransfer(context, operation.businessId, transferId);
      if (!row) throw notFoundError("Transfer not found");
      return this.hydrate(context, operation.businessId, row);
    });
  }

  async requestTransfer(operation: TransfersOperation, input: RequestTransferInput): Promise<Transfer> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "transfers.manage");

      // Retried requests dedupe to the same transfer before any money moves.
      const duplicate = await repository.findTransferByIdempotencyKey(context, operation.businessId, input.idempotencyKey);
      if (duplicate) return this.hydrate(context, operation.businessId, duplicate);

      const beneficiary = await repository.findBeneficiary(context, operation.businessId, input.beneficiaryId);
      if (!beneficiary) throw notFoundError("Beneficiary not found");
      if (beneficiary.status !== "active") throw validationError("Beneficiary is archived");

      const reference = `tr_${randomUUID()}`;
      const transfer = await repository.insertTransfer(context, operation.businessId, operation.userId, {
        id: randomUUID(),
        beneficiaryId: beneficiary.id,
        amountMinor: input.amountMinor.toString(),
        assetCode: DEFAULT_ASSET_CODE,
        purpose: input.purpose,
        status: "processing",
        reference,
        idempotencyKey: input.idempotencyKey,
        approvalRequestId: null,
        requestId: operation.requestId,
      });

      return this.executeThroughProvider(context, operation.businessId, transfer, beneficiary, input);
    });
  }

  /**
   * Resolves the payout recipient with the provider, initiates the transfer,
   * and records the attempt plus the resulting transfer status. A provider
   * failure is captured as a failed attempt and a failed transfer rather than
   * throwing, so the outcome is always persisted and observable.
   */
  private async executeThroughProvider(
    context: DatabaseContext,
    businessId: string,
    transfer: TransferRow,
    beneficiary: BeneficiaryRow,
    input: RequestTransferInput,
  ): Promise<Transfer> {
    const business = await businessesRepository.findBusiness(context, businessId);
    const sender =
      business?.addressLine1 && business.city && business.postalCode
        ? { businessName: business.displayName, addressLine1: business.addressLine1, city: business.city, country: business.country, postalCode: business.postalCode }
        : undefined;

    try {
      const recipient = await paymentProvider.createTransferRecipient({
        name: beneficiary.accountName,
        accountNumber: beneficiary.accountNumber,
        bankCode: beneficiary.bankCode,
        sender,
      });
      const result = await paymentProvider.initiateTransfer({
        amountMinor: transfer.amountMinor,
        recipientCode: recipient.recipientCode,
        reference: transfer.reference,
        reason: input.reason ?? `${transfer.purpose} transfer`,
        sourceAccountId: input.sourceProviderAccountId ?? null,
        customerEmail: input.customerEmail ?? null,
      });

      await repository.insertAttempt(context, businessId, {
        transferId: transfer.id,
        provider: paymentProvider.name,
        providerReference: transfer.reference,
        providerRecipientCode: recipient.recipientCode,
        providerTransferCode: result.transferCode,
        status: result.status === "success" ? "success" : result.status === "failed" ? "failed" : "processing",
        failureReason: null,
        rawResult: { transferCode: result.transferCode, status: result.status, reference: result.reference },
      });

      const updated = await repository.updateTransfer(context, businessId, transfer.id, {
        status: providerStatusToTransferStatus(result.status),
        failureReason: null,
      });
      return this.hydrate(context, businessId, updated ?? transfer);
    } catch (error) {
      // A provider/network failure is a business outcome, not a 500: the
      // transfer is marked failed and the attempt records why, inside the
      // same transaction, so nothing is left dangling in "processing".
      const reason = error instanceof AppError ? error.message : "Transfer provider request failed";
      await repository.insertAttempt(context, businessId, {
        transferId: transfer.id,
        provider: paymentProvider.name,
        providerReference: transfer.reference,
        providerRecipientCode: null,
        providerTransferCode: null,
        status: "failed",
        failureReason: reason,
        rawResult: null,
      });
      const updated = await repository.updateTransfer(context, businessId, transfer.id, { status: "failed", failureReason: reason });
      return this.hydrate(context, businessId, updated ?? transfer);
    }
  }

  private async hydrate(context: DatabaseContext, businessId: string, row: TransferRow): Promise<Transfer> {
    const attempts = await repository.listAttempts(context, businessId, row.id);
    return toTransfer(row, attempts);
  }

  private async run<T>(operation: TransfersOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function providerStatusToTransferStatus(status: "pending" | "processing" | "success" | "failed"): TransferStatus {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "processing";
}

function toBeneficiary(row: BeneficiaryRow): Beneficiary {
  return {
    id: row.id,
    partyId: row.partyId,
    kind: row.kind,
    bankCode: row.bankCode,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTransfer(row: TransferRow, attempts: readonly TransferAttemptRow[]): Transfer {
  return {
    id: row.id,
    beneficiaryId: row.beneficiaryId,
    amountMinor: row.amountMinor,
    assetCode: row.assetCode,
    purpose: row.purpose,
    status: row.status,
    reference: row.reference,
    journalEntryId: row.journalEntryId,
    approvalRequestId: row.approvalRequestId,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      provider: attempt.provider,
      providerReference: attempt.providerReference,
      providerTransferCode: attempt.providerTransferCode,
      status: attempt.status,
      failureReason: attempt.failureReason,
      createdAt: attempt.createdAt.toISOString(),
    })),
  };
}
