import BusinessService from "../services/business.service";
import {
  createMockSupabaseClient,
  createMockQueryBuilder,
  testFixtures,
} from "./test-utils";

// Mock Paystack utils
jest.mock("../utils/paystack.util", () => ({
  listBanks: jest.fn().mockResolvedValue([{ name: "Test Bank", code: "001" }]),
  createPaystackSubaccount: jest
    .fn()
    .mockResolvedValue({ subaccount_code: "SUB_123", id: 1 }),
  updatePaystackSubaccount: jest.fn().mockResolvedValue(true),
  fetchPaystackSubaccount: jest.fn().mockResolvedValue({
    business_name: "Test Business",
    settlement_bank: "Test Bank",
    account_number: "1234567890",
  }),
}));

describe("BusinessService - Subaccount", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let businessService: InstanceType<typeof BusinessService>;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    businessService = new BusinessService(mockSupabase as any);
  });

  describe("updateSubaccount", () => {
    it("should return full subaccount settings after update", async () => {
      const businessId = "test-business-id";

      // Mock getBusinessById
      const businessQueryBuilder = createMockQueryBuilder({
        id: businessId,
        name: "Initial Name",
        paystack_subaccount_code: "SUB_123",
        paystack_fee_bearer: "subaccount",
      });

      // Mock getSubaccountSettings internal DB call
      const settingsQueryBuilder = createMockQueryBuilder({
        name: "Test Business",
        paystack_subaccount_code: "SUB_123",
        paystack_fee_bearer: "subaccount",
      });

      mockSupabase.from.mockImplementation((table) => {
        if (table === "businesses") {
          // This is tricky because getBusinessById and getSubaccountSettings both use 'businesses'
          // and they might use different query builders or the same one.
          // getBusinessById uses .eq('id', ...).single()
          // getSubaccountSettings uses .select(...).eq('id', ...).single()
          return settingsQueryBuilder;
        }
        return createMockQueryBuilder(null);
      });

      // Mock updateSubaccountSettings
      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ data: null, error: null }),
      };

      // Override from to handle update
      mockSupabase.from.mockImplementation((table) => {
        if (table === "businesses") {
          // Check if it's the update call or select call
          return settingsQueryBuilder;
        }
        return createMockQueryBuilder(null);
      });

      // Let's refine the mock to be more specific if possible
      // But for this test, we mainly want to verify it returns what getSubaccountSettings returns.

      const spy = jest
        .spyOn(businessService, "getSubaccountSettings")
        .mockResolvedValue({
          business_name: "Updated Name",
          settlement_bank: "Test Bank",
          account_number: "1234567890",
          subaccount_code: "SUB_123",
          paystack_fee_bearer: "subaccount",
          settlement_schedule: "auto",
          flw_subaccount_id: null,
          flw_country: null,
        });

      const result = await businessService.updateSubaccount(businessId, {
        business_name: "Updated Name",
      });

      expect(spy).toHaveBeenCalledWith(businessId);
      expect(result).toEqual({
        business_name: "Updated Name",
        settlement_bank: "Test Bank",
        account_number: "1234567890",
        subaccount_code: "SUB_123",
        paystack_fee_bearer: "subaccount",
        settlement_schedule: "auto",
        flw_subaccount_id: null,
        flw_country: null,
      });
    });
  });
});
