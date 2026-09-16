/// <reference types="jest" />

import { BankingService } from "../services/banking.service";
import {
  createMockQueryBuilder,
  createMockSupabaseClient,
} from "./test-utils";
import {
  createPaystackDedicatedAccount,
  createPaystackTransferRecipient,
  fetchPaystackSubaccount,
  finalizePaystackTransfer,
  getPaystackTransfer,
  initiatePaystackTransfer,
  validatePaystackCustomer,
  verifyPaystackPayment,
} from "../utils/paystack.util";
import { scryptSync } from "node:crypto";

jest.mock("../utils/paystack.util", () => ({
  createPaystackCustomer: jest.fn(),
  validatePaystackCustomer: jest.fn(),
  createPaystackDedicatedAccount: jest.fn(),
  createPaystackTransferRecipient: jest.fn(),
  fetchPaystackSubaccount: jest.fn(),
  finalizePaystackTransfer: jest.fn(),
  getPaystackTransfer: jest.fn(),
  initiatePaystackTransfer: jest.fn(),
  requeryPaystackDedicatedAccount: jest.fn(),
  verifyPaystackPayment: jest.fn(),
}));

const businessId = "2d0acabc-2b37-4ca7-99b2-1d34e3512ec1";

function storedPinHash(pin: string): string {
  const salt = "a".repeat(32);
  const hash = scryptSync(`${pin}:hilaq-pin-pepper-v1`, salt, 32).toString("hex");
  return `${salt}.${hash}`;
}

describe("BankingService", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let service: BankingService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new BankingService(mockSupabase as any);
  });

  afterEach(() => jest.clearAllMocks());

  describe("requestVirtualAccount", () => {
    it("rejects DVA issuance before banking KYC is verified", async () => {
      mockSupabase.from.mockReturnValueOnce(
        createMockQueryBuilder({
          id: businessId,
          name: "Hilaq Store",
          paystack_customer_code: "CUS_123",
          banking_kyc_status: "pending",
        }),
      );

      await expect(
        service.requestVirtualAccount({ business_id: businessId }),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(createPaystackDedicatedAccount).not.toHaveBeenCalled();
    });

    it("creates a dedicated virtual account after banking KYC is verified", async () => {
      (createPaystackDedicatedAccount as jest.Mock).mockResolvedValue({
        id: 42,
        account_number: "1234567890",
        account_name: "Hilaq Store",
        bank: { name: "Wema Bank", slug: "wema-bank" },
      });

      mockSupabase.from
        .mockReturnValueOnce(
          createMockQueryBuilder({
            id: businessId,
            name: "Hilaq Store",
            paystack_customer_code: "CUS_123",
            banking_kyc_status: "verified",
          }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder({ name: "Dami Adeyemi", phone_number: "08012345678" }),
        )
        .mockReturnValueOnce(
          createMockQueryBuilder({
            id: "va-1",
            account_number: "1234567890",
            status: "active",
          }),
        );
      mockSupabase.auth.getUser.mockResolvedValue({
        data: {
          user: {
            id: "user-1",
            email: "test@example.com",
            user_metadata: { name: "Dami Adeyemi", phone: "08012345678" },
          },
        },
        error: null,
      });

      const account = await service.requestVirtualAccount({
        business_id: businessId,
        preferred_bank: "wema-bank",
      });

      expect(createPaystackDedicatedAccount).toHaveBeenCalledWith({
        customer: "CUS_123",
        email: "test@example.com",
        first_name: "Dami",
        last_name: "Adeyemi",
        phone: "08012345678",
        preferred_bank: "wema-bank",
      });
      expect(account).toMatchObject({
        account_number: "1234567890",
        status: "active",
      });
    });

    it("defaults to titan-paystack when no preferred_bank is supplied", async () => {
      // Regression test: the frontend's actual "Request account" call sends
      // no preferred_bank at all. Without a default, Paystack's own API
      // rejects the request with "Please choose a provider" once more than
      // one dedicated-account provider is enabled on the integration.
      (createPaystackDedicatedAccount as jest.Mock).mockResolvedValue({
        id: 42,
        account_number: "1234567890",
        account_name: "Hilaq Store",
        bank: { name: "Paystack-Titan", slug: "titan-paystack" },
      });

      mockSupabase.from
        .mockReturnValueOnce(
          createMockQueryBuilder({
            id: businessId,
            name: "Hilaq Store",
            paystack_customer_code: "CUS_123",
            banking_kyc_status: "verified",
          }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder({ name: "Dami Adeyemi", phone_number: "08012345678" }),
        )
        .mockReturnValueOnce(
          createMockQueryBuilder({
            id: "va-1",
            account_number: "1234567890",
            status: "active",
          }),
        );
      mockSupabase.auth.getUser.mockResolvedValue({
        data: {
          user: {
            id: "user-1",
            email: "test@example.com",
            user_metadata: { name: "Dami Adeyemi", phone: "08012345678" },
          },
        },
        error: null,
      });

      await service.requestVirtualAccount({ business_id: businessId });

      expect(createPaystackDedicatedAccount).toHaveBeenCalledWith(
        expect.objectContaining({ preferred_bank: "titan-paystack" }),
      );
    });
  });

  describe("submitKyc", () => {
    it("submits customer validation without storing raw BVN", async () => {
      const business = {
        id: businessId,
        name: "Hilaq Store",
        paystack_customer_code: "CUS_123",
        banking_kyc_status: "not_started",
      };
      const kycInsert = createMockQueryBuilder(null);
      const businessUpdate = createMockQueryBuilder(null);

      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(business))
        .mockReturnValueOnce(createMockQueryBuilder([]))
        .mockReturnValueOnce(
          createMockQueryBuilder({
            name: "Dami Adeyemi",
            phone_number: "08012345678",
          }),
        )
        .mockReturnValueOnce(kycInsert)
        .mockReturnValueOnce(businessUpdate);
      (validatePaystackCustomer as jest.Mock).mockResolvedValue({});
      mockSupabase.auth.getUser.mockResolvedValue({
        data: {
          user: {
            id: "user-1",
            email: "owner@example.com",
            user_metadata: { name: "Dami Adeyemi", phone: "08012345678" },
          },
        },
        error: null,
      });

      await service.submitKyc({
        business_id: businessId,
        email: "owner@example.com",
        first_name: "Dami",
        last_name: "Adeyemi",
        phone: "08012345678",
        bvn: "12345678901",
        bank_code: "058",
        account_number: "0123456789",
      });

      expect(validatePaystackCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ customerCode: "CUS_123", bvn: "12345678901" }),
      );
      expect(kycInsert.insert).toHaveBeenCalledWith(
        expect.objectContaining({ document_number: "*******8901" }),
      );
      expect(JSON.stringify(kycInsert.insert.mock.calls[0][0])).not.toContain(
        "12345678901",
      );
    });
  });

  describe("handleCustomerIdentificationEvent", () => {
    it("marks banking KYC verified from Paystack success webhook", async () => {
      const businessUpdate = createMockQueryBuilder(null);
      const kycUpdate = createMockQueryBuilder(null);

      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder({ id: businessId }))
        .mockReturnValueOnce(businessUpdate)
        .mockReturnValueOnce(createMockQueryBuilder({ id: "kyc-1" }))
        .mockReturnValueOnce(kycUpdate);

      await service.handleCustomerIdentificationEvent(
        { customer: { customer_code: "CUS_123" } },
        true,
      );

      expect(businessUpdate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          banking_kyc_status: "verified",
        }),
      );
      expect(kycUpdate.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "approved" }),
      );
    });
  });

  describe("recordDedicatedNubanDeposit", () => {
    const depositData = {
      reference: "ref-dva-1",
      authorization: { receiver_bank_account_number: "1234567890" },
    };
    const verifiedDeposit = {
      id: 123,
      amount: 50000,
      currency: "NGN",
      authorization: { channel: "dedicated_nuban" },
    };

    it("credits the wallet and returns true for a verified dedicated-nuban deposit", async () => {
      (verifyPaystackPayment as jest.Mock).mockResolvedValue(verifiedDeposit);
      const walletInsert = createMockQueryBuilder({ id: "tx-1" });

      mockSupabase.from
        .mockReturnValueOnce(
          createMockQueryBuilder({ id: "va-1", business_id: businessId }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(walletInsert);

      const recorded = await service.recordDedicatedNubanDeposit(depositData);

      expect(recorded).toBe(true);
      expect(walletInsert.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          business_id: businessId,
          provider_reference: "ref-dva-1",
          amount: 490,
          gross_amount: 500,
          fee_amount: 10,
          fee_breakdown: { paystack: 5, hilaq: 5 },
          status: "posted",
        }),
      );
    });

    it("returns true without double-crediting when the deposit already exists", async () => {
      (verifyPaystackPayment as jest.Mock).mockResolvedValue(verifiedDeposit);

      mockSupabase.from
        .mockReturnValueOnce(
          createMockQueryBuilder({ id: "va-1", business_id: businessId }),
        )
        .mockReturnValueOnce(createMockQueryBuilder({ id: "tx-1" }));

      const recorded = await service.recordDedicatedNubanDeposit(depositData);

      expect(recorded).toBe(true);
      expect(mockSupabase.from).toHaveBeenCalledTimes(2);
    });

    it("returns false when the account number matches no active virtual account", async () => {
      mockSupabase.from.mockReturnValueOnce(createMockQueryBuilder(null));

      const recorded = await service.recordDedicatedNubanDeposit(depositData);

      expect(recorded).toBe(false);
      expect(verifyPaystackPayment).not.toHaveBeenCalled();
    });

    it("returns false when the verified charge is not dedicated_nuban", async () => {
      (verifyPaystackPayment as jest.Mock).mockResolvedValue({
        id: 123,
        amount: 50000,
        currency: "NGN",
        authorization: { channel: "card" },
      });

      mockSupabase.from.mockReturnValueOnce(
        createMockQueryBuilder({ id: "va-1", business_id: businessId }),
      );

      const recorded = await service.recordDedicatedNubanDeposit(depositData);

      expect(recorded).toBe(false);
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    });
  });

  describe("requestWithdrawal", () => {
    const withdrawalRow = {
      id: "wd-1",
      amount: 2500,
      currency: "NGN",
      account_number: "0123456789",
      account_name: "Hilaq Store",
      status: "processing",
      provider_reference: "hilaq-wd-ref",
      provider_transfer_code: "TRF_code",
      failure_reason: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const pinRow = {
      id: "va-1",
      has_pin: true,
      pin_hash: storedPinHash("1234"),
      pin_attempts: 0,
      pin_locked_until: null,
    };

    beforeEach(() => {
      (createPaystackTransferRecipient as jest.Mock).mockResolvedValue({
        recipient_code: "RCP_1",
      });
      (initiatePaystackTransfer as jest.Mock).mockResolvedValue({
        transfer_code: "TRF_code",
        reference: "hilaq-wd-ref",
        status: "processing",
      });
      (fetchPaystackSubaccount as jest.Mock).mockResolvedValue({
        business_name: "Hilaq Store",
        settlement_bank: "058",
        account_number: "0123456789",
      });
    });

    it("sends to the business settlement account when no destination is supplied", async () => {
      const walletInsert = createMockQueryBuilder({ id: "tx-1" });
      const withdrawalInsert = createMockQueryBuilder({ id: "wd-1" });
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(pinRow))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder([
            { direction: "credit", amount: 10000, status: "posted" },
          ]),
        )
        .mockReturnValueOnce(
          createMockQueryBuilder({
            name: "Hilaq Store",
            paystack_subaccount_code: "SUB_123",
          }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(withdrawalInsert)
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(walletInsert)
        .mockReturnValueOnce(createMockQueryBuilder(withdrawalRow));

      const withdrawal = await service.requestWithdrawal(
        businessId,
        "user-1",
        {
          business_id: businessId,
          amount: 2500,
          pin: "1234",
          idempotency_key: "withdraw-abc-123",
        },
      );

      expect(createPaystackTransferRecipient).toHaveBeenCalledWith({
        name: "Hilaq Store",
        account_number: "0123456789",
        bank_code: "058",
      });
      expect(withdrawalInsert.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          business_id: businessId,
          amount: 2500,
          bank_code: "058",
          account_number: "0123456789",
          account_name: "Hilaq Store",
          idempotency_key: "withdraw-abc-123",
        }),
      );
      expect(withdrawal.status).toBe("processing");
    });

    it("keeps accepting explicit destination details (send-money path)", async () => {
      const walletInsert = createMockQueryBuilder({ id: "tx-1" });
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(pinRow))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder([
            { direction: "credit", amount: 10000, status: "posted" },
          ]),
        )
        .mockReturnValueOnce(createMockQueryBuilder({ id: "wd-1" }))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(walletInsert)
        .mockReturnValueOnce(createMockQueryBuilder(withdrawalRow));

      await service.requestWithdrawal(businessId, "user-1", {
        business_id: businessId,
        amount: 2500,
        pin: "1234",
        bank_code: "044",
        account_number: "9876543210",
        account_name: "Some Vendor",
      });

      expect(createPaystackTransferRecipient).toHaveBeenCalledWith({
        name: "Some Vendor",
        account_number: "9876543210",
        bank_code: "044",
      });
      expect(fetchPaystackSubaccount).not.toHaveBeenCalled();
    });

    it("rejects the withdrawal when the balance is insufficient", async () => {
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(pinRow))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder([
            { direction: "credit", amount: 1000, status: "posted" },
          ]),
        );

      await expect(
        service.requestWithdrawal(businessId, "user-1", {
          business_id: businessId,
          amount: 2500,
          pin: "1234",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Insufficient wallet balance",
      });

      expect(createPaystackTransferRecipient).not.toHaveBeenCalled();
    });

    it("rejects the withdrawal when no settlement account is configured", async () => {
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(pinRow))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder([
            { direction: "credit", amount: 10000, status: "posted" },
          ]),
        )
        .mockReturnValueOnce(
          createMockQueryBuilder({
            name: "Hilaq Store",
            paystack_subaccount_code: null,
          }),
        );

      await expect(
        service.requestWithdrawal(businessId, "user-1", {
          business_id: businessId,
          amount: 2500,
          pin: "1234",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(createPaystackTransferRecipient).not.toHaveBeenCalled();
    });

    it("returns the existing withdrawal for a repeated idempotency key", async () => {
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(pinRow))
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(
          createMockQueryBuilder([
            { direction: "credit", amount: 10000, status: "posted" },
          ]),
        )
        .mockReturnValueOnce(
          createMockQueryBuilder({
            name: "Hilaq Store",
            paystack_subaccount_code: "SUB_123",
          }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(withdrawalRow));

      const withdrawal = await service.requestWithdrawal(
        businessId,
        "user-1",
        {
          business_id: businessId,
          amount: 2500,
          pin: "1234",
          idempotency_key: "withdraw-abc-123",
        },
      );

      expect(withdrawal.id).toBe("wd-1");
      expect(createPaystackTransferRecipient).not.toHaveBeenCalled();
      expect(initiatePaystackTransfer).not.toHaveBeenCalled();
    });

    it("rejects a wrong PIN before touching the balance", async () => {
      mockSupabase.from
        .mockReturnValueOnce(
          createMockQueryBuilder({
            ...pinRow,
            pin_hash: storedPinHash("9999"),
          }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(null));

      await expect(
        service.requestWithdrawal(businessId, "user-1", {
          business_id: businessId,
          amount: 100,
          pin: "1234",
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
        details: { code: "PIN_INCORRECT", remaining_attempts: 2 },
      });
    });
  });

  describe("finalizeWithdrawal", () => {
    const withdrawalRow = {
      id: "wd-1",
      amount: 5000,
      currency: "NGN",
      account_number: "0123456789",
      account_name: "Test Account",
      status: "success",
      provider_reference: "hilaq-wd-ref",
      provider_transfer_code: "TRF_code",
      failure_reason: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    it("requeries a processing transfer and marks the wallet transaction posted on success", async () => {
      (finalizePaystackTransfer as jest.Mock).mockResolvedValue({
        transfer_code: "TRF_code",
        reference: "hilaq-wd-ref",
        status: "processing",
      });
      (getPaystackTransfer as jest.Mock).mockResolvedValue({
        transfer_code: "TRF_code",
        reference: "hilaq-wd-ref",
        status: "success",
      });

      const walletTxBuilder = createMockQueryBuilder(null);
      mockSupabase.from
        .mockReturnValueOnce(
          createMockQueryBuilder({ id: "wd-1", provider_transfer_code: "TRF_code" }),
        )
        .mockReturnValueOnce(createMockQueryBuilder(null))
        .mockReturnValueOnce(walletTxBuilder)
        .mockReturnValueOnce(createMockQueryBuilder(withdrawalRow));

      const result = await service.finalizeWithdrawal({
        business_id: businessId,
        transfer_code: "TRF_code",
        otp: "123456",
      });

      expect(finalizePaystackTransfer).toHaveBeenCalledWith({
        transfer_code: "TRF_code",
        otp: "123456",
      });
      expect(getPaystackTransfer).toHaveBeenCalledWith("TRF_code");
      expect(walletTxBuilder.update).toHaveBeenCalledWith({ status: "posted" });
      expect(result.status).toBe("success");
    });
  });
});
