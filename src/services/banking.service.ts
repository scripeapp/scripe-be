import { SupabaseClient } from "@supabase/supabase-js";
import {
  createPaystackCustomer,
  createPaystackDedicatedAccount,
  createPaystackTransferRecipient,
  finalizePaystackTransfer,
  initiatePaystackTransfer,
  requeryPaystackDedicatedAccount,
  resolvePaystackBankAccount,
  getPaystackTransfer,
  validatePaystackCustomer,
  verifyPaystackPayment,
  type PaystackDedicatedAccount,
} from "../utils/paystack.util";
import { calculateVaDepositFees, KOBOS_PER_NAIRA } from "../utils/payment/fees";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";
import { PinService } from "../services/pin.service";
import { BusinessService } from "../services/business.service";
import type {
  RequestVirtualAccountInput,
  RequestWithdrawalInput,
  ResolveBankAccountInput,
  SubmitBankingKycInput,
  FinalizeWithdrawalInput,
} from "../types/banking.schemas";

const REQUERY_COOLDOWN_MS = 10 * 60 * 1000;

// Paystack's own first-party dedicated-account provider. The frontend never
// actually sends `preferred_bank` today, and Paystack's /dedicated_account
// endpoint rejects the request outright ("Please choose a provider") once
// more than one provider is enabled on the integration and none is
// specified — confirmed live. Falling back to this default keeps account
// creation working regardless of whether a caller supplies one.
const DEFAULT_DEDICATED_ACCOUNT_PROVIDER = "titan-paystack";

interface BusinessBankingRecord {
  id: string;
  name: string;
  support_email?: string | null;
  support_phone?: string | null;
  paystack_customer_code?: string | null;
  banking_kyc_status?: string | null;
  banking_kyc_failure_reason?: string | null;
}

interface KycProfile {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

interface SettlementAccount {
  bank_code: string;
  account_number: string;
  account_name: string;
}

export class BankingService {
  constructor(private readonly supabase: SupabaseClient) {}

  async getStatus(businessId: string) {
    const business = await this.getBusiness(businessId);
    const virtualAccount = await this.getCurrentVirtualAccount(businessId);
    const balance = await this.getWalletBalance(businessId);

    return {
      kyc_status: business.banking_kyc_status ?? "not_started",
      kyc_failure_reason: business.banking_kyc_failure_reason,
      is_verified: business.banking_kyc_status === "verified",
      paystack_customer_code: business.paystack_customer_code,
      virtual_account: virtualAccount,
      balance,
      currency: "NGN",
      has_pin: virtualAccount?.has_pin ?? false,
      pin_attempts: virtualAccount?.pin_attempts ?? 0,
      pin_locked_until: virtualAccount?.pin_locked_until ?? null,
    };
  }

  async resolveBankAccount(input: ResolveBankAccountInput) {
    const resolved = await resolvePaystackBankAccount({
      account_number: input.account_number,
      bank_code: input.bank_code,
    });
    return { account_name: resolved.account_name };
  }

  async submitKyc(input: SubmitBankingKycInput) {
    const business = await this.getBusiness(input.business_id);
    await this.assertKycCanBeSubmitted(business);
    const profile = {
      email: input.email,
      firstName: input.first_name,
      lastName: input.last_name,
      phone: input.phone,
    };
    const customerCode = await this.ensurePaystackCustomer(business, profile);

    let alreadyValidated = false;
    try {
      await validatePaystackCustomer({
        customerCode,
        first_name: profile.firstName,
        last_name: profile.lastName,
        bvn: input.bvn,
        bank_code: input.bank_code,
        account_number: input.account_number,
      });
    } catch (error) {
      if (!this.isAlreadyValidatedError(error)) throw error;
      alreadyValidated = true;
    }

    await this.saveKycProfile(profile);
    await this.recordBvnKyc(
      input,
      customerCode,
      alreadyValidated ? "approved" : "pending",
      alreadyValidated ? "verified" : "pending",
    );

    return {
      status: alreadyValidated ? "verified" : "pending",
      paystack_customer_code: customerCode,
      message: alreadyValidated
        ? "Banking KYC was already validated by Paystack"
        : "Banking KYC submitted for validation",
    };
  }

  async requestVirtualAccount(input: RequestVirtualAccountInput) {
    const business = await this.getBusiness(input.business_id);
    this.assertKycVerified(business);

    const existing = await this.getCurrentVirtualAccount(input.business_id);
    if (existing) return existing;

    if (!business.paystack_customer_code) {
      throw this.httpError("Paystack customer is not ready for this business", 409);
    }

    const profile = await this.getKycProfile(business);

    const dedicatedAccount = await createPaystackDedicatedAccount({
      customer: business.paystack_customer_code,
      email: profile.email,
      first_name: profile.firstName,
      last_name: profile.lastName,
      phone: profile.phone,
      preferred_bank: input.preferred_bank ?? DEFAULT_DEDICATED_ACCOUNT_PROVIDER,
    });

    return this.createVirtualAccountFromPaystack(
      input.business_id,
      business.paystack_customer_code,
      dedicatedAccount,
    );
  }

  async requeryVirtualAccount(businessId: string) {
    const account = await this.getCurrentVirtualAccount(businessId);
    if (!account) {
      throw this.httpError("No virtual account request found", 404);
    }
    if (!account.account_number || !account.bank_slug) {
      throw this.httpError("Virtual account is not ready for requery", 409);
    }

    const lastRequeryAt = account.last_requery_at
      ? new Date(account.last_requery_at).getTime()
      : 0;
    if (Date.now() - lastRequeryAt < REQUERY_COOLDOWN_MS) {
      throw this.httpError("Try requerying again after 10 minutes", 429);
    }

    const response = await requeryPaystackDedicatedAccount({
      account_number: account.account_number,
      provider_slug: account.bank_slug,
      date: new Date().toISOString().slice(0, 10),
    });

    await this.updateVirtualAccount(account.id, response, "active", {
      last_requery_at: new Date().toISOString(),
    });

    return this.getCurrentVirtualAccount(businessId);
  }

  async listTransactions(businessId: string, page = 1, limit = 50) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, count, error } = await this.supabase
      .from("wallet_transactions")
      .select(
        "id, type, direction, amount, status, provider_reference, description, metadata, gross_amount, fee_amount, fee_breakdown, posted_at, created_at",
        { count: "exact" },
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw error;
    const enriched = await this.attachApprovalRequestIds(data ?? []);
    return { data: enriched, totalCount: count ?? 0 };
  }

  /**
   * A "pending" bill_payment debit (posted the moment the payment is
   * confirmed — see debitWalletForBillPayment) covers two different real
   * states: a transfer already in flight at Paystack, or one still sitting
   * behind a gated approval. Attaches the matching approval_requests id (if
   * any) so the frontend can render "Awaiting approval" distinctly and
   * offer Approve/Reject right on the transaction, instead of leaving it
   * indistinguishable from an ordinary in-flight transfer.
   */
  private async attachApprovalRequestIds<T extends { type: string; status: string; metadata: any }>(
    transactions: T[],
  ): Promise<(T & { approval_request_id: string | null })[]> {
    const paymentIds = transactions
      .filter((t) => t.type === "bill_payment" && t.status === "pending" && t.metadata?.payment_id)
      .map((t) => t.metadata.payment_id as string);

    const requestIdByPaymentId = new Map<string, string>();
    if (paymentIds.length > 0) {
      const { data: requests } = await this.supabase
        .from("approval_requests")
        .select("id, subject_id")
        .eq("subject_type", "bill_transfer")
        .eq("status", "pending")
        .in("subject_id", paymentIds);
      for (const r of requests ?? []) requestIdByPaymentId.set(r.subject_id, r.id);
    }

    return transactions.map((t) => ({
      ...t,
      approval_request_id:
        t.type === "bill_payment" && t.metadata?.payment_id
          ? (requestIdByPaymentId.get(t.metadata.payment_id as string) ?? null)
          : null,
    }));
  }

  async requestWithdrawal(
    businessId: string,
    requestedBy: string | undefined,
    input: RequestWithdrawalInput,
  ) {
    await this.assertKycVerifiedForTransacting(businessId, "sending money from your wallet");

    const pinService = new PinService(this.supabase);
    await pinService.verify(businessId, input.pin);

    const balance = await this.getWalletBalance(businessId);
    if (input.amount > balance.available) {
      throw this.httpError("Insufficient wallet balance", 400);
    }

    const settlement =
      input.bank_code && input.account_number && input.account_name
        ? {
            bank_code: input.bank_code,
            account_number: input.account_number,
            account_name: input.account_name,
          }
        : await this.getSettlementAccount(businessId);

    if (input.idempotency_key) {
      const existing = await this.getWithdrawalByIdempotencyKey(
        businessId,
        input.idempotency_key,
      );
      if (existing) return existing;
    }

    const recipient = await createPaystackTransferRecipient({
      name: settlement.account_name,
      account_number: settlement.account_number,
      bank_code: settlement.bank_code,
    });
    const reference = createTransactionReference(REFERENCE_TYPES.WITHDRAWAL);

    const { data: withdrawal, error: withdrawalError } = await this.supabase
      .from("banking_withdrawals")
      .insert({
        business_id: businessId,
        requested_by: requestedBy,
        amount: input.amount,
        bank_code: settlement.bank_code,
        account_number: settlement.account_number,
        account_name: settlement.account_name,
        transfer_recipient_code: recipient.recipient_code,
        provider_reference: reference,
        idempotency_key: input.idempotency_key ?? null,
        status: "pending",
      })
      .select("id")
      .single();
    if (withdrawalError) {
      // A concurrent request with the same idempotency key already won the
      // race — return that withdrawal instead of creating a duplicate.
      if (withdrawalError.code === "23505" && input.idempotency_key) {
        const existing = await this.getWithdrawalByIdempotencyKey(
          businessId,
          input.idempotency_key,
        );
        if (existing) return existing;
      }
      throw withdrawalError;
    }

    const transfer = await initiatePaystackTransfer({
      amount: input.amount,
      recipient: recipient.recipient_code,
      reference,
      reason: "Hilaq wallet withdrawal",
    });

    await this.supabase
      .from("banking_withdrawals")
      .update({
        provider_transfer_code: transfer.transfer_code,
        status: this.mapTransferStatus(transfer.status),
      })
      .eq("id", withdrawal.id);

    await this.postWalletTransaction({
      businessId,
      type: "withdrawal",
      direction: "debit",
      status: "pending",
      providerReference: reference,
      description: "Wallet withdrawal",
      amount: input.amount,
      metadata: { withdrawal_id: withdrawal.id, transfer },
    });

    return this.getWithdrawalByReference(reference);
  }

  /**
   * Reset a locked transaction PIN using the last 4 digits of the BVN that
   * verified this business. Used from the withdrawal flow's locked state.
   */
  async resetBvnPin(businessId: string, bvnLast4: string): Promise<void> {
    const pinService = new PinService(this.supabase);
    await pinService.resetLockedPinWithBvn(businessId, bvnLast4);
  }

  async finalizeWithdrawal(input: FinalizeWithdrawalInput) {
    const { data: withdrawal, error } = await this.supabase
      .from("banking_withdrawals")
      .select("id, provider_transfer_code")
      .eq("business_id", input.business_id)
      .eq("provider_transfer_code", input.transfer_code)
      .maybeSingle();
    if (error) throw error;
    if (!withdrawal) {
      throw this.httpError("Withdrawal not found", 404);
    }

    const transfer = await finalizePaystackTransfer({
      transfer_code: input.transfer_code,
      otp: input.otp,
    });

    let status = this.mapTransferStatus(transfer.status);
    if (status === "processing") {
      // The bank may settle seconds after finalize; requery once for a fresher status.
      // On requery failure we keep the processing status — the webhook settles it later.
      try {
        const refreshed = await getPaystackTransfer(transfer.transfer_code);
        status = this.mapTransferStatus(refreshed.status);
      } catch {
        // Keep the current status.
      }
    }

    const { error: updateError } = await this.supabase
      .from("banking_withdrawals")
      .update({
        status,
        provider_reference: transfer.reference,
      })
      .eq("id", withdrawal.id);
    if (updateError) throw updateError;

    // Reconcile the pending wallet debit so the sent money stops showing as
    // "pending" on the dashboard the moment the transfer is confirmed.
    // The Paystack webhook also does this, but finalize may be the only signal.
    if (status === "success") {
      const { error: txError } = await this.supabase
        .from("wallet_transactions")
        .update({ status: "posted" })
        .eq("provider", "paystack")
        .eq("provider_reference", transfer.reference);
      if (txError) throw txError;
    }

    return this.getWithdrawalByReference(transfer.reference);
  }

  async handleCustomerIdentificationEvent(data: any, success: boolean) {
    const customerCode = this.getCustomerCode(data);
    if (!customerCode) return;

    const { data: business } = await this.supabase
      .from("businesses")
      .select("id")
      .eq("paystack_customer_code", customerCode)
      .maybeSingle();
    if (!business) return;

    const failureReason =
      data?.reason || data?.message || data?.gateway_response || null;
    const kycStatus = success ? "verified" : "failed";

    const { error: businessError } = await this.supabase
      .from("businesses")
      .update({
        banking_kyc_status: kycStatus,
        banking_kyc_verified_at: success ? new Date().toISOString() : null,
        banking_kyc_failure_reason: success ? null : failureReason,
      })
      .eq("id", business.id);
    if (businessError) throw businessError;

    await this.updateLatestBvnKyc(
      business.id,
      success ? "approved" : "rejected",
      failureReason,
      data,
    );
  }

  async handleDedicatedAccountAssignmentEvent(data: any, success: boolean) {
    const customerCode = this.getCustomerCode(data);
    const accountNumber = this.getAccountNumber(data);
    const failureReason = data?.reason || data?.message || null;

    let businessId: string | null = null;
    if (customerCode) {
      const { data: business } = await this.supabase
        .from("businesses")
        .select("id")
        .eq("paystack_customer_code", customerCode)
        .maybeSingle();
      businessId = business?.id ?? null;
    }

    if (!businessId && accountNumber) {
      const { data: account } = await this.supabase
        .from("virtual_accounts")
        .select("business_id")
        .eq("account_number", accountNumber)
        .maybeSingle();
      businessId = account?.business_id ?? null;
    }

    if (!businessId) return;

    const existing = await this.getCurrentVirtualAccount(businessId);
    const status = success ? "active" : "failed";
    if (existing) {
      await this.updateVirtualAccount(existing.id, data, status, {
        failure_reason: success ? null : failureReason,
      });
      return;
    }

    if (success) {
      await this.createVirtualAccountFromPaystack(
        businessId,
        customerCode ?? undefined,
        data,
      );
    }
  }

  /**
   * Credit a business wallet for a dedicated-nuban deposit.
   *
   * Returns whether the deposit was recorded. A false result means the charge
   * is not a wallet deposit for one of our virtual accounts (wrong channel,
   * unknown account number, or already outside our accounting) — callers must
   * not report it as fulfilled. Re-running is safe: an existing
   * wallet_transactions row for the reference short-circuits to true.
   */
  async recordDedicatedNubanDeposit(data: any): Promise<boolean> {
    const reference = data?.reference;
    const accountNumber = this.getAccountNumber(data);
    if (!reference || !accountNumber) return false;

    const { data: virtualAccount } = await this.supabase
      .from("virtual_accounts")
      .select("id, business_id")
      .eq("account_number", accountNumber)
      .eq("status", "active")
      .maybeSingle();
    if (!virtualAccount) return false;

    const verified = await verifyPaystackPayment(reference);
    if (verified.authorization?.channel !== "dedicated_nuban") return false;

    const { data: existing } = await this.supabase
      .from("wallet_transactions")
      .select("id")
      .eq("provider", "paystack")
      .eq("provider_reference", reference)
      .maybeSingle();
    if (existing) return true;

    const grossAmount = verified.amount / KOBOS_PER_NAIRA;
    const fees = calculateVaDepositFees(verified.amount);

    await this.postWalletTransaction({
      businessId: virtualAccount.business_id,
      type: "deposit",
      direction: "credit",
      status: "posted",
      providerReference: reference,
      description: "Dedicated virtual account deposit",
      amount: grossAmount - fees.totalFee,
      grossAmount,
      feeAmount: fees.totalFee,
      feeBreakdown: { paystack: fees.paystackFee, hilaq: fees.hilaqFee },
      metadata: {
        virtual_account_id: virtualAccount.id,
        paystack_transaction_id: verified.id,
        currency: verified.currency,
      },
    });
    return true;
  }

  async handleTransferEvent(data: any, status: "success" | "failed" | "reversed") {
    const reference = data?.reference;
    if (!reference) return;

    const { data: withdrawal } = await this.supabase
      .from("banking_withdrawals")
      .select("id, business_id, amount")
      .eq("provider_reference", reference)
      .maybeSingle();

    if (withdrawal) {
      const update = {
        status,
        failure_reason: status === "success" ? null : data?.reason || data?.message || null,
        provider_transfer_code: data?.transfer_code ?? undefined,
      };
      const { error } = await this.supabase
        .from("banking_withdrawals")
        .update(update)
        .eq("id", withdrawal.id);
      if (error) throw error;

      if (status === "success") {
        await this.supabase
          .from("wallet_transactions")
          .update({ status: "posted" })
          .eq("provider", "paystack")
          .eq("provider_reference", reference);
        return;
      }

      await this.postWalletTransaction({
        businessId: withdrawal.business_id,
        type: "reversal",
        direction: "credit",
        status: "posted",
        providerReference: `${reference}:reversal`,
        description: "Withdrawal reversal",
        amount: Number(withdrawal.amount),
        metadata: { withdrawal_id: withdrawal.id, transfer: data },
      });
      return;
    }

    // Not a withdrawal — check whether it's a supplier bill payment
    // transfer instead (see StoreService.executeBillTransfer). Settles a
    // transfer that was still 'processing' when initiatePaystackTransfer
    // returned, or confirms/reverses one this app already resolved
    // synchronously — finalize_supplier_payment is idempotent either way.
    const { data: payment } = await this.supabase
      .from("supplier_payments")
      .select("id, store_id, amount, status")
      .eq("provider_reference", reference)
      .maybeSingle();
    if (!payment) return;
    if (["successful", "failed", "reversed"].includes(payment.status)) return;

    const mappedStatus = status === "success" ? "successful" : "failed";
    const { error: finalizeError } = await this.supabase.rpc("finalize_supplier_payment", {
      p_payment_id: payment.id,
      p_status: mappedStatus,
      p_provider_transfer_code: data?.transfer_code ?? null,
      p_failure_reason: status === "success" ? null : data?.reason || data?.message || null,
    });
    if (finalizeError) throw finalizeError;

    if (mappedStatus === "successful") {
      await this.markBillPaymentDebitPosted(payment.id);
      return;
    }

    const { data: store } = await this.supabase
      .from("stores")
      .select("business_id")
      .eq("id", payment.store_id)
      .maybeSingle();
    if (!store) return;

    await this.reverseWalletDebit({
      businessId: store.business_id,
      providerReference: payment.id,
      amount: Number(payment.amount),
      description: "Bill payment transfer failed",
      metadata: { payment_id: payment.id, transfer: data },
    });
  }

  isDedicatedNubanCharge(data: any): boolean {
    return data?.authorization?.channel === "dedicated_nuban";
  }

  private async getBusiness(businessId: string): Promise<BusinessBankingRecord> {
    const { data, error } = await this.supabase
      .from("businesses")
      .select(
        "id, name, support_email, support_phone, paystack_customer_code, banking_kyc_status, banking_kyc_failure_reason",
      )
      .eq("id", businessId)
      .single();

    if (error) {
      console.error("[BankingService.getBusiness] Business lookup failed", {
        businessId,
        code: error.code,
        details: error.details,
        hint: error.hint,
        message: error.message,
      });

      if (error.code === "PGRST116") {
        throw this.httpError(
          "Business not found or you do not have access to this business",
          404,
        );
      }

      if (error.code === "42703" || error.code === "PGRST204") {
        throw this.httpError(
          "Banking services are temporarily unavailable. Please try again in a few minutes.",
          503,
        );
      }

      if (error.code === "42501") {
        throw this.httpError(
          "You do not have access to this business",
          403,
        );
      }

      throw this.httpError("Unable to load business banking details", 500);
    }

    if (!data) {
      throw this.httpError("Business not found", 404);
    }
    return data as BusinessBankingRecord;
  }

  private async ensurePaystackCustomer(
    business: BusinessBankingRecord,
    profile: KycProfile,
  ): Promise<string> {
    if (business.paystack_customer_code) return business.paystack_customer_code;

    const customer = await createPaystackCustomer({
      email: profile.email,
      first_name: profile.firstName,
      last_name: profile.lastName,
      phone: profile.phone,
      metadata: { business_id: business.id, business_name: business.name },
    });

    const { error } = await this.supabase
      .from("businesses")
      .update({ paystack_customer_code: customer.customer_code })
      .eq("id", business.id);
    if (error) throw error;

    return customer.customer_code;
  }

  private async saveKycProfile(profile: KycProfile): Promise<void> {
    const { data } = await this.supabase.auth.getUser();
    if (!data.user?.id) return;

    const { error } = await this.supabase
      .from("users")
      .update({
        name: `${profile.firstName} ${profile.lastName}`.trim(),
        phone_number: profile.phone,
      })
      .eq("id", data.user.id);
    if (error) throw error;
  }

  private async getKycProfile(business: BusinessBankingRecord): Promise<KycProfile> {
    const { data } = await this.supabase.auth.getUser();
    const metadata = data.user?.user_metadata ?? {};
    const userId = data.user?.id;
    let profile: {
      name?: string | null;
      phone_number?: string | null;
    } | null = null;

    if (userId) {
      const { data: userProfile, error } = await this.supabase
        .from("users")
        .select("name, phone_number")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      profile = userProfile;
    }

    const fullName = String(
      profile?.name ?? metadata.full_name ?? metadata.name ?? business.name,
    );
    const nameParts = fullName.trim().split(/\s+/).filter(Boolean);
    const firstName = String(
      metadata.first_name ?? nameParts[0] ?? "Business",
    );
    const lastName = String(
      metadata.last_name ?? nameParts.slice(1).join(" ") ?? "Owner",
    );
    const email = String(data.user?.email ?? business.support_email ?? "");
    const phone = String(
      profile?.phone_number ??
        metadata.phone ??
        metadata.phone_number ??
        business.support_phone ??
        "",
    );

    if (!email || !phone) {
      throw this.httpError(
        "Add an email address and phone number to your profile before completing KYC",
        422,
      );
    }

    return { email, firstName, lastName, phone };
  }

  private async recordBvnKyc(
    input: SubmitBankingKycInput,
    customerCode: string,
    kycStatus: "pending" | "approved",
    bankingStatus: "pending" | "verified",
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error: kycError } = await this.supabase
      .from("kyc_verifications")
      .insert({
        business_id: input.business_id,
        document_type: "bvn",
        document_number: `*******${input.bvn.slice(-4)}`,
        status: kycStatus,
        metadata: {
          paystack_customer_code: customerCode,
          bank_code: input.bank_code,
          account_number: input.account_number,
        },
      });
    if (kycError) throw kycError;

    const { error: businessError } = await this.supabase
      .from("businesses")
      .update({
        banking_kyc_status: bankingStatus,
        banking_kyc_submitted_at: now,
        banking_kyc_verified_at: bankingStatus === "verified" ? now : null,
        banking_kyc_failure_reason: null,
      })
      .eq("id", input.business_id);
    if (businessError) throw businessError;
  }

  private isAlreadyValidatedError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.toLowerCase().includes("customer already validated")
    );
  }

  private assertKycVerified(business: BusinessBankingRecord): void {
    if (business.banking_kyc_status === "verified") return;
    throw this.httpError("Complete banking KYC before requesting a virtual account", 403);
  }

  /**
   * Guards any wallet-money-movement entry point (a manual withdrawal, a
   * bill payment debiting the wallet) — without this, a business with no
   * completed KYC and no virtual account can still debit its wallet and
   * even fire a real Paystack transfer, with the result invisible in its
   * own Banking > Transactions page (which gates on having a virtual
   * account) until it eventually finishes verification. `action` fills a
   * "Complete banking verification before {action}" message, so each
   * caller gets wording that matches what it was trying to do.
   */
  async assertKycVerifiedForTransacting(businessId: string, action: string): Promise<void> {
    const { data: business, error } = await this.supabase
      .from("businesses")
      .select("banking_kyc_status")
      .eq("id", businessId)
      .maybeSingle();
    if (error) throw error;
    if (business?.banking_kyc_status === "verified") return;
    throw this.httpError(`Complete banking verification before ${action}`, 400);
  }

  private async assertKycCanBeSubmitted(
    business: BusinessBankingRecord,
  ): Promise<void> {
    if (business.banking_kyc_status === "verified") {
      throw this.httpError("Banking KYC is already verified", 409);
    }
    if (business.banking_kyc_status === "pending") {
      throw this.httpError("Banking KYC is already pending review", 409);
    }

    const { data, error } = await this.supabase
      .from("kyc_verifications")
      .select("id, status")
      .eq("business_id", business.id)
      .eq("document_type", "bvn")
      .in("status", ["pending", "approved"])
      .limit(1);
    if (error) throw error;

    if (!data || data.length === 0) return;

    const status = data[0].status;
    throw this.httpError(
      status === "approved"
        ? "Banking KYC is already verified"
        : "Banking KYC is already pending review",
      409,
    );
  }

  private async getCurrentVirtualAccount(businessId: string) {
    const { data, error } = await this.supabase
      .from("virtual_accounts")
      .select(
        "id, provider, provider_customer_code, provider_account_id, account_number, account_name, bank_name, bank_slug, currency, status, assignment_reference, last_requery_at, failure_reason, metadata, created_at, updated_at, has_pin, pin_attempts, pin_locked_until",
      )
      .eq("business_id", businessId)
      .in("status", ["pending", "active"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  /**
   * The business's configured settlement (payout) account — the only
   * destination wallet withdrawals are allowed to go to. Resolved from the
   * Paystack subaccount; never accepted from the client.
   */
  private async getSettlementAccount(businessId: string): Promise<SettlementAccount> {
    const businessService = new BusinessService(this.supabase);
    const settings = await businessService.getSubaccountSettings(businessId);

    if (!settings.settlement_bank || !settings.account_number) {
      throw this.httpError(
        "Set up your payout account in Business Settings before withdrawing",
        409,
      );
    }

    return {
      bank_code: settings.settlement_bank,
      account_number: settings.account_number,
      account_name:
        settings.business_name ?? "Business payout account",
    };
  }

  private async getWithdrawalByIdempotencyKey(businessId: string, idempotencyKey: string) {
    const { data, error } = await this.supabase
      .from("banking_withdrawals")
      .select(
        "id, amount, currency, account_number, account_name, status, provider_reference, provider_transfer_code, failure_reason, created_at, updated_at",
      )
      .eq("business_id", businessId)
      .eq("idempotency_key", idempotencyKey)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  private async createVirtualAccountFromPaystack(
    businessId: string,
    customerCode: string | undefined,
    account: PaystackDedicatedAccount,
  ) {
    const status = account.account_number ? "active" : "pending";
    const { data, error } = await this.supabase
      .from("virtual_accounts")
      .insert({
        business_id: businessId,
        provider_customer_code: customerCode ?? account.customer?.customer_code,
        provider_account_id: account.id ? String(account.id) : null,
        account_number: account.account_number ?? null,
        account_name: account.account_name ?? null,
        bank_name: account.bank?.name ?? null,
        bank_slug: account.bank?.slug ?? null,
        status,
        assignment_reference: account.assignment?.reference ?? null,
        metadata: account,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  private async updateVirtualAccount(
    id: string,
    account: any,
    status: "active" | "failed",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const update = {
      provider_account_id: account?.id ? String(account.id) : undefined,
      account_number: this.getAccountNumber(account) ?? undefined,
      account_name: account?.account_name ?? account?.account?.account_name ?? undefined,
      bank_name: account?.bank?.name ?? account?.account?.bank?.name ?? undefined,
      bank_slug: account?.bank?.slug ?? account?.account?.bank?.slug ?? undefined,
      status,
      metadata: account,
      ...extra,
    };

    const { error } = await this.supabase
      .from("virtual_accounts")
      .update(update)
      .eq("id", id);
    if (error) throw error;
  }

  /** Public wrapper — used by StoreService to check a business's wallet
   * balance before confirming a supplier bill payment. */
  async getAvailableBalance(businessId: string): Promise<number> {
    const balance = await this.getWalletBalance(businessId);
    return balance.available;
  }

  /** Posts the wallet debit for a supplier bill payment. Called at the
   * moment a payment is confirmed (gated or not) — not deferred until a
   * gated transfer is actually approved — so a second concurrent payment
   * submitted during the approval window sees the balance already reduced.
   * Same double-spend fix docs/transfers-approvals-backend-plan.md
   * describes for gated withdrawals, applied here from day one. */
  async debitWalletForBillPayment(params: {
    businessId: string;
    amount: number;
    providerReference: string;
    description: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.postWalletTransaction({
      businessId: params.businessId,
      type: "bill_payment",
      direction: "debit",
      status: "pending",
      providerReference: params.providerReference,
      description: params.description,
      amount: params.amount,
      metadata: params.metadata,
    });
  }

  /** Reverses a previously-posted bill-payment debit when the transfer
   * ultimately fails or is rejected — never rewrites the original debit
   * row, matches the existing webhook-failure convention in
   * handleTransferEvent. */
  async reverseWalletDebit(params: {
    businessId: string;
    providerReference: string;
    amount: number;
    description: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.postWalletTransaction({
      businessId: params.businessId,
      type: "reversal",
      direction: "credit",
      status: "posted",
      providerReference: `${params.providerReference}:reversal`,
      description: params.description,
      amount: params.amount,
      metadata: params.metadata,
    });
  }

  /** Marks a pending bill-payment debit as settled once the transfer
   * succeeds — mirrors how a withdrawal's pending debit is posted on
   * confirmed success. */
  async markBillPaymentDebitPosted(providerReference: string): Promise<void> {
    const { error } = await this.supabase
      .from("wallet_transactions")
      .update({ status: "posted" })
      .eq("provider", "paystack")
      .eq("provider_reference", providerReference);
    if (error) throw error;
  }

  private async getWalletBalance(businessId: string) {
    const { data, error } = await this.supabase
      .from("wallet_transactions")
      .select("direction, amount, status")
      .eq("business_id", businessId)
      .in("status", ["pending", "posted"]);
    if (error) throw error;

    const available = (data ?? []).reduce((sum: number, entry: any) => {
      const amount = Number(entry.amount);
      return entry.direction === "credit" ? sum + amount : sum - amount;
    }, 0);

    return { available: Number(available.toFixed(2)) };
  }

  private async postWalletTransaction(params: {
    businessId: string;
    type: "deposit" | "withdrawal" | "reversal" | "adjustment" | "bill_payment";
    direction: "credit" | "debit";
    status: "pending" | "posted";
    providerReference: string;
    description: string;
    amount: number;
    grossAmount?: number;
    feeAmount?: number;
    feeBreakdown?: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const { data: existing } = await this.supabase
      .from("wallet_transactions")
      .select("id")
      .eq("provider", "paystack")
      .eq("provider_reference", params.providerReference)
      .maybeSingle();
    if (existing) return;

    const { error: txError } = await this.supabase
      .from("wallet_transactions")
      .insert({
        business_id: params.businessId,
        type: params.type,
        direction: params.direction,
        amount: params.amount,
        gross_amount: params.grossAmount ?? params.amount,
        fee_amount: params.feeAmount ?? 0,
        fee_breakdown: params.feeBreakdown ?? {},
        status: params.status,
        provider_reference: params.providerReference,
        description: params.description,
        metadata: params.metadata,
      })
      .select("id")
      .single();
    if (txError) {
      if (txError.code === "23505") return;
      throw txError;
    }
  }

  private async updateLatestBvnKyc(
    businessId: string,
    status: "approved" | "rejected",
    failureReason: string | null,
    eventData: any,
  ): Promise<void> {
    const { data: latest } = await this.supabase
      .from("kyc_verifications")
      .select("id")
      .eq("business_id", businessId)
      .eq("document_type", "bvn")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return;

    const { error } = await this.supabase
      .from("kyc_verifications")
      .update({
        status,
        reviewed_at: new Date().toISOString(),
        rejection_reason: failureReason,
        metadata: { paystack_event: eventData },
      })
      .eq("id", latest.id);
    if (error) throw error;
  }

  private async getWithdrawalByReference(reference: string) {
    const { data, error } = await this.supabase
      .from("banking_withdrawals")
      .select(
        "id, amount, currency, account_number, account_name, status, provider_reference, provider_transfer_code, failure_reason, created_at, updated_at",
      )
      .eq("provider_reference", reference)
      .single();
    if (error) throw error;
    return data;
  }

  private getCustomerCode(data: any): string | undefined {
    return (
      data?.customer?.customer_code ??
      data?.customer_code ??
      data?.dedicated_account?.customer?.customer_code
    );
  }

  private getAccountNumber(data: any): string | undefined {
    return (
      data?.account_number ??
      data?.account?.account_number ??
      data?.dedicated_account?.account_number ??
      data?.authorization?.receiver_bank_account_number
    );
  }

  private mapTransferStatus(status: string): "pending" | "processing" | "success" | "failed" {
    if (status === "success") return "success";
    if (status === "failed") return "failed";
    return "processing";
  }

  private httpError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode });
  }
}
