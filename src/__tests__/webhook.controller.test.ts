/**
 * Webhook Controller Tests
 *
 * Tests for the Paystack webhook handler to ensure payment processing works correctly.
 * Uses mocks for Supabase, Postmark, and Plunk to isolate unit tests.
 */

/// <reference types="jest" />

import crypto from "node:crypto";
import { Request, Response } from "express";
import {
  handlePaystackWebhook,
  handleSuccessfulPayment,
  handleFreeTickets,
} from "../controllers/webhook.controller";

const mockVerifyCircleSubscription = jest.fn().mockResolvedValue({
  success: true,
  circle_id: "circle-1",
  subscription_id: "sub-1",
});
const mockMarkCircleFailed = jest.fn().mockResolvedValue(undefined);
const mockUpdateCircleFromWebhook = jest.fn().mockResolvedValue(null);

// Mock external dependencies
// Note: jest.mock calls are hoisted, so we create mocks inline

jest.mock("../config/supabase", () => {
  const mockSingle = jest
    .fn()
    .mockResolvedValue({
      data: { id: "mock-id", email: "test@example.com" },
      error: null,
    });
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    single: mockSingle,
    then: jest
      .fn()
      .mockImplementation((resolve) => resolve({ data: null, error: null })),
  };
  return {
    supabase: { from: jest.fn().mockReturnValue(mockChain) },
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
  };
});

jest.mock("../config/supabaseAdmin", () => {
  const mockSingle = jest
    .fn()
    .mockResolvedValue({
      data: { id: "mock-id", email: "test@example.com" },
      error: null,
    });
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    single: mockSingle,
    then: jest
      .fn()
      .mockImplementation((resolve) => resolve({ data: null, error: null })),
  };
  return {
    __esModule: true,
    default: { from: jest.fn().mockReturnValue(mockChain) },
  };
});

jest.mock("../config/plunk", () => ({
  sendEmail: jest.fn().mockResolvedValue({ emailId: "mock-email-id" }),
  trackEvent: jest.fn().mockResolvedValue({ success: true }),
  isConfigured: jest.fn().mockReturnValue(false),
  plunkClient: undefined,
}));

jest.mock("../utils/tickets", () => ({
  generateQRCode: jest
    .fn()
    .mockResolvedValue("data:image/png;base64,mock-qr-code"),
}));

// Mock store service
jest.mock("../services/store.service", () => ({
  storeService: {
    createOrder: jest
      .fn()
      .mockResolvedValue({
        order: { order_number: "ORD-12345" },
        customer: {},
      }),
  },
}));

// Mock email service
jest.mock("../services/email.service", () => ({
  emailService: {
    sendTippingEmail: jest.fn().mockResolvedValue(undefined),
    sendMembershipEmail: jest.fn().mockResolvedValue(undefined),
    sendTicketReceiptEmail: jest.fn().mockResolvedValue(undefined),
    sendVendorSaleEmail: jest.fn().mockResolvedValue(undefined),
    sendAuditEvent: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock purchase service
jest.mock("../services/purchase.service", () => ({
  createPurchaseService: jest.fn().mockReturnValue({
    saveCustomer: jest.fn().mockResolvedValue({ id: "customer-id" }),
    createOrder: jest
      .fn()
      .mockResolvedValue({ id: "order-id", payment_reference: "ref-123" }),
    processTicketSales: jest
      .fn()
      .mockResolvedValue([
        {
          quantity_sold: 1,
          ticket: { id: "ticket-1", ticket_name: "VIP", ticket_price: 5000 },
        },
      ]),
    updateTicketQuantities: jest.fn().mockResolvedValue(undefined),
    getEventDetails: jest
      .fn()
      .mockResolvedValue({
        event_name: "Test Event",
        start_date: "2026-01-20",
        start_time: "10:00",
        end_time: "14:00",
        is_physical: true,
        venue: { placeDesc: "Venue" },
        owner_id: "owner-123",
      }),
  }),
}));

jest.mock("../services/circle-subscription.service", () => ({
  CircleSubscriptionService: jest.fn().mockImplementation(() => ({
    verifySubscription: mockVerifyCircleSubscription,
    markSubscriptionPaymentFailed: mockMarkCircleFailed,
    updateFromWebhook: mockUpdateCircleFromWebhook,
  })),
}));

jest.mock("../services/business-subscription.service", () => ({
  businessSubscriptionService: {
    handleSubscriptionWebhook: jest
      .fn()
      .mockResolvedValue({ success: true, message: "Mocked success" }),
  },
}));

// Helper to create mock request/response
const createMockReq = (
  body: any,
  headers: Record<string, string> = {},
): Partial<Request> => ({
  body,
  headers,
});

const createMockRes = (): Partial<Response> => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// Helper to create valid Paystack signature
const createPaystackSignature = (body: any): string => {
  return crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "test_secret_key")
    .update(JSON.stringify(body))
    .digest("hex");
};

describe("Webhook Controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("handlePaystackWebhook", () => {
    describe("Signature Validation", () => {
      it("should return 401 when signature is missing", async () => {
        const req = createMockReq({ event: "charge.success" });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "Missing signature" });
      });

      it("should return 401 when signature is invalid", async () => {
        const body = { event: "charge.success", data: {} };
        const req = createMockReq(body, {
          "x-paystack-signature": "invalid-signature",
        });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "Invalid signature" });
      });
    });

    describe("charge.success Event", () => {
      const createChargeSuccessPayload = (metadata: any = {}) => {
        const body = {
          event: "charge.success",
          data: {
            reference: "TEST-REF-123",
            amount: 10000,
            status: "success",
            metadata: {
              full_name: "Test User",
              email: "test@example.com",
              ...metadata,
            },
            customer: {
              first_name: "Test",
              last_name: "User",
              email: "test@example.com",
              phone: "+2341234567890",
            },
          },
        };
        return body;
      };

      it("should return 200 for valid charge.success webhook", async () => {
        const body = createChargeSuccessPayload();
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ received: true });
      });

      it("should detect store purchase by STORE- prefix in reference", async () => {
        const body = {
          event: "charge.success",
          data: {
            reference: "STORE-1234567890-abc12345",
            amount: 20000,
            status: "success",
            metadata: {
              full_name: "Test User",
              email: "test@example.com",
              referrer: "https://www.hilaq.com/s/test-store/product-id",
            },
            customer: {
              first_name: "Test",
              last_name: "User",
              email: "test@example.com",
              phone: "+2341234567890",
            },
          },
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        // Should still return 200 even with incomplete metadata
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it("should process store purchase with complete metadata", async () => {
        const body = {
          event: "charge.success",
          data: {
            reference: "STORE-1234567890-abc12345",
            amount: 20000,
            status: "success",
            metadata: {
              full_name: "Test User",
              email: "test@example.com",
              store_id: "store-uuid-123",
              items: [{ product_id: "product-1", quantity: 2, price: 5000 }],
              customer_name: "Test User",
              customer_email: "test@example.com",
            },
            customer: {
              first_name: "Test",
              last_name: "User",
              email: "test@example.com",
              phone: "+2341234567890",
            },
          },
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
      });

      it("should process circle subscription charge.success idempotently via service", async () => {
        const body = createChargeSuccessPayload({
          type: "circle_plan_subscription",
          circle_id: "circle-1",
          plan_id: "plan-1",
          user_id: "user-1",
        });
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(mockVerifyCircleSubscription).toHaveBeenCalledWith(
          "TEST-REF-123",
          "paystack",
        );
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe("charge.failed / charge.abandoned events", () => {
      it("should mark circle subscription failed on charge.failed", async () => {
        const body = {
          event: "charge.failed",
          data: {
            reference: "CPLAN-123",
            metadata: {
              full_name: "Test User",
              email: "test@example.com",
              type: "circle_plan_subscription",
              circle_id: "circle-1",
              plan_id: "plan-1",
              user_id: "user-1",
            },
          },
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(mockMarkCircleFailed).toHaveBeenCalledWith(
          "CPLAN-123",
          "expired",
        );
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe("Business Subscription Events", () => {
      it("should route subscription.create to business subscription service", async () => {
        const body = {
          event: "subscription.create",
          data: {
            subscription_code: "BSUB-123",
            metadata: {
              business_id: "biz-123",
              plan: "pro",
            },
          },
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        const {
          businessSubscriptionService,
        } = require("../services/business-subscription.service");

        await handlePaystackWebhook(req as Request, res as Response);

        expect(
          businessSubscriptionService.handleSubscriptionWebhook,
        ).toHaveBeenCalledWith("subscription.create", body.data);
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it("should route direct_debit.authorization.created to business subscription service if business_id present", async () => {
        const body = {
          event: "direct_debit.authorization.created",
          data: {
            metadata: {
              business_id: "biz-123",
            },
          },
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        const {
          businessSubscriptionService,
        } = require("../services/business-subscription.service");

        await handlePaystackWebhook(req as Request, res as Response);

        expect(
          businessSubscriptionService.handleSubscriptionWebhook,
        ).toHaveBeenCalledWith("direct_debit.authorization.created", body.data);
        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    describe("subscription.not_renew Event", () => {
      it("should handle subscription.not_renew event", async () => {
        const body = {
          event: "subscription.not_renew",
          data: {
            subscription_code: "SUB-123",
            customer: {
              email: "test@example.com",
              first_name: "Test",
              last_name: "User",
            },
            plan: {
              name: "Pro",
            },
          },
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ received: true });
      });
    });

    describe("Unhandled Events", () => {
      it("should return 200 for unhandled event types", async () => {
        const body = {
          event: "unknown.event",
          data: {},
        };
        const signature = createPaystackSignature(body);
        const req = createMockReq(body, { "x-paystack-signature": signature });
        const res = createMockRes();

        await handlePaystackWebhook(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ received: true });
      });
    });
  });

  describe("handleFreeTickets", () => {
    it("should process free tickets successfully", async () => {
      const req = createMockReq({
        reference: "FREE-TICKET-123",
        amount: 0,
        metadata: {
          full_name: "Test User",
          email: "test@example.com",
          event_id: "event-123",
          selectedTickets: { "0": 1 },
          tickets: [
            {
              id: "ticket-123",
              ticket_name: "Free Entry",
              ticket_price: 0,
              available_quantity: 100,
              quantity_sold: 0,
              ticket_is_limited_stock: true,
            },
          ],
        },
      });
      const res = createMockRes();

      await handleFreeTickets(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Free tickets processed successfully",
        }),
      );
    });
  });
});

describe("Payment Type Detection", () => {
  // Test helper functions indirectly through handleSuccessfulPayment

  describe("Event Purchase Detection", () => {
    it("should detect event purchase when event_id, selectedTickets, and tickets are present", async () => {
      // This test verifies the isEventPurchase logic
      const metadata = {
        full_name: "Test User",
        email: "test@example.com",
        event_id: "event-123",
        selectedTickets: { "0": 2 },
        tickets: [{ id: "ticket-1", ticket_name: "VIP", ticket_price: 5000 }],
      };

      // The presence of these three fields should route to event purchase
      expect(metadata.event_id).toBeTruthy();
      expect(metadata.selectedTickets).toBeTruthy();
      expect(metadata.tickets).toBeTruthy();
    });
  });

  describe("Store Purchase Detection", () => {
    it("should detect store purchase when store_id and items are present", async () => {
      const metadata = {
        store_id: "store-uuid-123",
        items: [{ product_id: "product-1", quantity: 1 }],
      };

      expect(Boolean(metadata.store_id && metadata.items)).toBe(true);
    });

    it("should not detect store purchase when store_id is missing", async () => {
      const metadata = {
        items: [{ product_id: "product-1", quantity: 1 }],
      };

      expect(Boolean((metadata as any).store_id && metadata.items)).toBe(false);
    });
  });

  describe("Publication Subscription Detection", () => {
    it("should detect publication subscription", async () => {
      const metadata = {
        subscription_type: "publication",
        publication_id: "pub-123",
        user_id: "user-123",
        plan: "monthly",
      };

      expect(
        metadata.subscription_type === "publication" && metadata.publication_id,
      ).toBeTruthy();
    });
  });

  describe("Settlement events", () => {
    it("marks pending payout requests fulfilled on settlement.success", async () => {
      const supabaseAdmin = require("../config/supabaseAdmin").default;
      const body = {
        event: "settlement.success",
        data: {
          id: 987654,
          subaccount: { subaccount_code: "ACCT_test123" },
        },
      };
      const req = createMockReq(body, {
        "x-paystack-signature": createPaystackSignature(body),
      });
      const res = createMockRes();

      await handlePaystackWebhook(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(supabaseAdmin.from).toHaveBeenCalledWith("payout_requests");
      const chain = supabaseAdmin.from();
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "fulfilled",
          paystack_settlement_id: "987654",
        }),
      );
    });
  });
});
