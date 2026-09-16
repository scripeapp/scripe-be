/**
 * Tests for FinancialsService payout + settlement behaviour.
 *
 * Covers payout request creation (happy path, duplicate guard, validation)
 * and real Paystack settlement aggregation (kobo -> naira, pending vs settled).
 */

/// <reference types="jest" />

import { FinancialsService } from "../services/financials.service";
import {
  createMockSupabaseClient,
  createMockQueryBuilder,
} from "./test-utils";

jest.mock("../config/supabaseAdmin", () => ({ __esModule: true, default: null }));
jest.mock("../services/email.service", () => ({
  emailService: { sendPayoutRequestEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../services/admin-alerts.service", () => ({
  adminAlertsService: { createAlert: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../utils/paystack.util", () => ({
  listPaystackSettlements: jest.fn(),
  fetchPaystackSubaccount: jest.fn(),
}));

import { listPaystackSettlements } from "../utils/paystack.util";

const businessId = "business-1";
const requestedBy = "user-1";

describe("FinancialsService payouts", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let service: FinancialsService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new FinancialsService(mockSupabase as any);
  });

  afterEach(() => jest.clearAllMocks());

  describe("requestPayout", () => {
    it("creates a pending request when none is open", async () => {
      const createdRequest = {
        id: "req-1",
        business_id: businessId,
        amount: 5000,
        status: "pending",
      };
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder([])) // duplicate check
        .mockReturnValueOnce(createMockQueryBuilder(createdRequest)) // insert
        .mockReturnValue(createMockQueryBuilder([])); // best-effort notifications

      const result = await service.requestPayout(businessId, requestedBy, 5000);

      expect(result).toEqual(createdRequest);
      expect(mockSupabase.from).toHaveBeenCalledWith("payout_requests");
    });

    it("rejects when an open request already exists", async () => {
      mockSupabase.from.mockReturnValueOnce(
        createMockQueryBuilder([{ id: "existing" }]),
      );

      await expect(
        service.requestPayout(businessId, requestedBy, 5000),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("rejects a non-positive amount before touching the database", async () => {
      await expect(
        service.requestPayout(businessId, requestedBy, 0),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });
  });

  describe("getSettlements", () => {
    it("aggregates pending and settled amounts in naira", async () => {
      mockSupabase.from.mockReturnValue(
        createMockQueryBuilder({ paystack_subaccount_id: 12345 }),
      );
      (listPaystackSettlements as jest.Mock).mockResolvedValue({
        settlements: [
          {
            id: 1,
            status: "success",
            total_amount: 100000,
            effective_amount: 99000,
            total_fees: 1000,
            currency: "NGN",
            settlement_date: "2026-06-01",
          },
          {
            id: 2,
            status: "pending",
            total_amount: 50000,
            effective_amount: 50000,
            total_fees: 0,
            currency: "NGN",
            settlement_date: "2026-06-20",
          },
        ],
        meta: {},
      });

      const result = await service.getSettlements(businessId);

      expect(listPaystackSettlements).toHaveBeenCalledWith({
        subaccount: "12345",
        perPage: 100,
      });
      expect(result.settled_amount).toBe(990); // 99000 kobo
      expect(result.pending_amount).toBe(500); // 50000 kobo
      expect(result.history).toHaveLength(2);
      expect(result.history[0].amount).toBe(1000);
    });

    it("returns zeros when the business has no subaccount", async () => {
      mockSupabase.from.mockReturnValue(
        createMockQueryBuilder({
          paystack_subaccount_id: null,
          paystack_subaccount_code: null,
        }),
      );

      const result = await service.getSettlements(businessId);

      expect(result).toEqual({
        pending_amount: 0,
        settled_amount: 0,
        history: [],
      });
      expect(listPaystackSettlements).not.toHaveBeenCalled();
    });
  });
});
