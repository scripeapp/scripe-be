import { StoreService } from "../services/store.service";
import { createMockSupabaseClient, createMockQueryBuilder } from "./test-utils";
import { storeEmailService } from "../utils/storeEmails.util";
import { AvailabilityService } from "../services/availability.service";

const mockAdminFrom = jest.fn();
const mockAdminRpc = jest.fn().mockResolvedValue({ data: null, error: null });

jest.mock("../utils/storeEmails.util", () => ({
  storeEmailService: {
    sendOrderConfirmation: jest.fn().mockResolvedValue(true),
    sendNewOrderNotification: jest.fn().mockResolvedValue(true),
    sendDigitalProductLinks: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock("../services/availability.service");

// Route service-role reads/writes through the same request-scoped test double.
jest.mock("../config/supabase", () => ({
  supabase: {},
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
  },
}));

jest.mock("../config/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
  },
  default: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
  },
}));

describe("StoreService.processFreePurchase", () => {
  let storeService: StoreService;
  let mockSupabase: any;

  const mockStoreId = "test-store-id";
  const mockCustomer = {
    name: "Free Buyer",
    email: "free@example.com",
    phone: "1234567890",
    address: "123 Free St",
  };
  const mockProduct = {
    id: "prod-1",
    name: "Free Digital Guide",
    price: 0,
    stock: 10,
    status: "published",
    type: "digital",
    cover_image: "image.jpg",
    orders_count: 0,
  };

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    mockSupabase.rpc.mockResolvedValue({ data: true, error: null });
    storeService = new StoreService(mockSupabase as any);
    jest.clearAllMocks();
    mockAdminFrom.mockImplementation((table: string) =>
      mockSupabase.from(table),
    );
    (AvailabilityService as jest.Mock).mockImplementation(() => ({
      validateSlotAvailability: jest
        .fn()
        .mockResolvedValue({ isAvailable: true }),
    }));
  });

  it("should successfully process a free purchase for a zero-priced product", async () => {
    // 1. Mock product fetch
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "products") {
        return createMockQueryBuilder([mockProduct]);
      }
      if (table === "users") {
        return createMockQueryBuilder({ id: "user-123" });
      }
      if (table === "stores") {
        return createMockQueryBuilder({
          name: "Test Store",
          business_id: "biz-123",
          user_id: "owner-123",
        });
      }
      if (table === "store_orders") {
        return createMockQueryBuilder({
          ...mockProduct,
          id: "order-123",
          payment_reference: "HLQ-ORD-3FK29QN7",
          store_id: mockStoreId,
        });
      }
      if (table === "customers") {
        return createMockQueryBuilder({ id: "cust-123" });
      }
      if (table === "discount_codes") return createMockQueryBuilder([]);
      return createMockQueryBuilder({});
    });

    const data = {
      store_id: mockStoreId,
      customer: mockCustomer,
      items: [
        {
          product_id: mockProduct.id,
          quantity: 1,
        },
      ],
    };

    const result = await storeService.processFreePurchase(data);

    expect(result.order).toBeDefined();
    expect(result.order.payment_reference).toMatch(/^HLQ-ORD-/);

    // Verify stock was updated
    expect(mockSupabase.from).toHaveBeenCalledWith("products");
    expect(mockSupabase.from).toHaveBeenCalledWith("store_orders");

    // Verify emails were sent
    expect(storeEmailService.sendOrderConfirmation).toHaveBeenCalled();
  });

  it("should throw error if total is not actually zero", async () => {
    const paidProduct = { ...mockProduct, price: 1000 };

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "products") {
        return createMockQueryBuilder([paidProduct]);
      }
      if (table === "discount_codes") return createMockQueryBuilder([]);
      return createMockQueryBuilder({});
    });

    const data = {
      store_id: mockStoreId,
      customer: mockCustomer,
      items: [
        {
          product_id: paidProduct.id,
          quantity: 1,
        },
      ],
    };

    await expect(storeService.processFreePurchase(data)).rejects.toThrow(
      "Cannot process non-free purchase through free channel",
    );
  });

  it("persists the applied code and deducted amount on a discounted order", async () => {
    const paidProduct = { ...mockProduct, price: 1000 };
    const discountCode = {
      id: "discount-1",
      store_id: mockStoreId,
      kind: "code",
      name: null,
      code: "FREE100",
      type: "percentage",
      value: 100,
      applies_to: "all",
      product_ids: [],
      is_active: true,
      usage_count: 0,
      max_usage: null,
      one_use_per_customer: false,
      starts_at: null,
      expires_at: null,
      trigger: null,
      trigger_value: null,
      qualification_product_ids: [],
      allow_code_on_top: false,
      show_on_storefront: true,
    };
    const storeOrderBuilder = createMockQueryBuilder({
      id: "order-discounted",
      payment_reference: "FREE-DISCOUNT",
      store_id: mockStoreId,
      items: [],
    });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "products") return createMockQueryBuilder([paidProduct]);
      if (table === "discount_codes") {
        const builder = createMockQueryBuilder([]);
        builder.maybeSingle.mockResolvedValue({
          data: discountCode,
          error: null,
        });
        return builder;
      }
      if (table === "users")
        return createMockQueryBuilder({ id: "user-123" });
      if (table === "stores")
        return createMockQueryBuilder({
          name: "Test Store",
          business_id: "biz-123",
          user_id: "owner-123",
        });
      if (table === "store_orders") return storeOrderBuilder;
      if (table === "customers")
        return createMockQueryBuilder({ id: "cust-123" });
      return createMockQueryBuilder({});
    });

    await storeService.processFreePurchase({
      store_id: mockStoreId,
      customer: mockCustomer,
      discount_code: "FREE100",
      items: [{ product_id: paidProduct.id, quantity: 1 }],
    });

    expect(storeOrderBuilder.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        subtotal: 1000,
        discount: 1000,
        discount_code: "FREE100",
        discount_details: [
          {
            id: "discount-1",
            kind: "code",
            name: "FREE100",
            code: "FREE100",
            amount: 1000,
            show_on_storefront: true,
          },
        ],
      }),
    ]);
  });
});
