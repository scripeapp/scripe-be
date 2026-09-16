/**
 * Tests for EmailService
 *
 * Tests email sending functionality including tipping, membership, tickets, and audit emails.
 * Mocks the new Plunk REST API helper (src/lib/plunk.ts).
 */

import EmailService from "../services/email.service";

// Mock the Plunk lib (new REST API helpers)
const mockSendEmail = jest.fn().mockResolvedValue({ emailId: "test-email-id" });
const mockIsConfigured = jest.fn().mockReturnValue(true);

jest.mock("../lib/plunk", () => ({
  sendEmail: (...args: any[]) => mockSendEmail(...args),
  isConfigured: () => mockIsConfigured(),
  trackEvent: jest.fn().mockResolvedValue({ success: true }),
  plunkClient: {},
  PlunkClient: jest.fn(),
  PlunkError: class extends Error {
    status: number;
    responseBody: any;
    constructor(msg: string, status: number, body?: any) {
      super(msg);
      this.name = "PlunkError";
      this.status = status;
      this.responseBody = body;
    }
  },
}));

// Mock the config/plunk which re-exports from lib/plunk
jest.mock("../config/plunk", () => ({
  sendEmail: (...args: any[]) => mockSendEmail(...args),
  isConfigured: () => mockIsConfigured(),
  trackEvent: jest.fn().mockResolvedValue({ success: true }),
  plunkClient: {},
  PlunkClient: jest.fn(),
  PlunkError: class extends Error {
    status: number;
    responseBody: any;
    constructor(msg: string, status: number, body?: any) {
      super(msg);
      this.name = "PlunkError";
      this.status = status;
      this.responseBody = body;
    }
  },
}));

// Mock the supabaseAdmin
jest.mock("../config/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { name: "Test Business", email: "business@example.com" },
        error: null,
      }),
    }),
  },
}));

// Mock email templates
jest.mock("../utils/emailsTemplate", () => ({
  eventTicketReceiptCustomer: jest
    .fn()
    .mockReturnValue("<html>Ticket Receipt</html>"),
  eventTicketVendorNotification: jest
    .fn()
    .mockReturnValue("<html>Vendor Notification</html>"),
  tippingConfirmationEmail: jest
    .fn()
    .mockReturnValue("<html>Tipping Confirmation</html>"),
  membershipWelcomeEmail: jest
    .fn()
    .mockReturnValue("<html>Membership Welcome</html>"),
  auditEventEmail: jest.fn().mockReturnValue("<html>Audit Event</html>"),
}));

describe("EmailService", () => {
  let emailService: EmailService;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue({ emailId: "test-email-id" });
    mockIsConfigured.mockReturnValue(true);

    emailService = new EmailService();
  });

  // ==========================================================================
  // sendTippingEmail
  // ==========================================================================
  describe("sendTippingEmail", () => {
    const tippingParams = {
      userEmail: "user@example.com",
      userName: "John Doe",
      recipientName: "Jane Smith",
    };

    it("should send tipping confirmation email", async () => {
      await emailService.sendTippingEmail(tippingParams);

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: tippingParams.userEmail,
          name: "Hilaq",
          subject: "Your tip has been sent successfully!",
          type: "html",
        }),
      );
    });

    it("should use template for tipping confirmation body", async () => {
      const { tippingConfirmationEmail } = require("../utils/emailsTemplate");
      await emailService.sendTippingEmail(tippingParams);

      expect(tippingConfirmationEmail).toHaveBeenCalledWith({
        userName: tippingParams.userName,
        recipientName: tippingParams.recipientName,
      });
    });
  });

  // ==========================================================================
  // sendMembershipEmail
  // ==========================================================================
  describe("sendMembershipEmail", () => {
    const membershipParams = {
      userEmail: "member@example.com",
      userName: "Premium User",
    };

    it("should send membership welcome email", async () => {
      await emailService.sendMembershipEmail(membershipParams);

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: membershipParams.userEmail,
          name: "Hilaq Membership",
          subject: "Welcome to Hilaq Plus Membership!",
          type: "html",
        }),
      );
    });

    it("should use template for membership welcome body", async () => {
      const { membershipWelcomeEmail } = require("../utils/emailsTemplate");
      await emailService.sendMembershipEmail(membershipParams);

      expect(membershipWelcomeEmail).toHaveBeenCalledWith({
        userName: membershipParams.userName,
      });
    });
  });

  // ==========================================================================
  // sendTicketReceiptEmail
  // ==========================================================================
  describe("sendTicketReceiptEmail", () => {
    const ticketParams = {
      userEmail: "attendee@example.com",
      ticketId: "ticket-123",
      eventName: "Tech Conference 2026",
      eventDate: "2026-07-15 · 10:00",
      venue: "Lagos Conference Centre",
    };

    it("should send ticket receipt email with event name in subject", async () => {
      await emailService.sendTicketReceiptEmail(ticketParams);

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ticketParams.userEmail,
          name: "Hilaq Events",
          subject: `Your ticket for ${ticketParams.eventName}`,
          type: "html",
        }),
      );
    });

    it("should use custom subject when provided and within length limit", async () => {
      await emailService.sendTicketReceiptEmail({
        ...ticketParams,
        confirmationEmail: { subject: "See you at Tech Conference!" },
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "See you at Tech Conference!",
        }),
      );
    });

    it("should use template for ticket receipt body", async () => {
      const { eventTicketReceiptCustomer } = require("../utils/emailsTemplate");

      await emailService.sendTicketReceiptEmail(ticketParams);

      expect(eventTicketReceiptCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: ticketParams.ticketId }),
      );
    });
  });

  // ==========================================================================
  // sendVendorSaleEmail
  // ==========================================================================
  describe("sendVendorSaleEmail", () => {
    const vendorParams = {
      vendorEmail: "vendor@example.com",
      vendorName: "Event Organizer",
      eventId: "event-123",
      eventName: "Quran Competition",
      buyerName: "John Attendee",
      amount: 5000,
      currency: "NGN",
      quantity: 2,
      dateTime: "2025-03-15 10:00",
    };

    it("should send vendor notification email", async () => {
      await emailService.sendVendorSaleEmail(vendorParams);

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: vendorParams.vendorEmail,
          name: "Hilaq Events",
          subject: "🎉 New Ticket Sale on Hilaq!",
          type: "html",
        }),
      );
    });

    it("should use vendor notification template", async () => {
      const {
        eventTicketVendorNotification,
      } = require("../utils/emailsTemplate");

      await emailService.sendVendorSaleEmail(vendorParams);

      expect(eventTicketVendorNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorName: vendorParams.vendorName,
          eventName: vendorParams.eventName,
          buyerName: vendorParams.buyerName,
          amount: vendorParams.amount,
          currency: vendorParams.currency,
          quantity: vendorParams.quantity,
        }),
      );
    });
  });

  // ==========================================================================
  // sendAuditEvent
  // ==========================================================================
  describe("sendAuditEvent", () => {
    const auditParams = {
      toEmail: "audit@hilaq.com",
      eventName: "PAYMENT_RECEIVED",
      payload: { amount: 5000, reference: "TXN-123" },
    };

    it("should send audit email", async () => {
      await emailService.sendAuditEvent(auditParams);

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: auditParams.toEmail,
          name: "Hilaq Audit",
          subject: `[Audit] ${auditParams.eventName}`,
          type: "html",
        }),
      );
    });

    it("should use audit template for body", async () => {
      const { auditEventEmail } = require("../utils/emailsTemplate");
      await emailService.sendAuditEvent(auditParams);

      expect(auditEventEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: auditParams.eventName,
        }),
      );
    });

    it("should silently skip when Plunk is not configured", async () => {
      mockIsConfigured.mockReturnValue(false);
      const serviceWithoutPlunk = new EmailService();

      // Should not throw
      await expect(
        serviceWithoutPlunk.sendAuditEvent(auditParams),
      ).resolves.toBeUndefined();

      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // send (generic method)
  // ==========================================================================
  describe("send", () => {
    it("should send platform email with default sender", async () => {
      await emailService.send({
        to: "user@example.com",
        subject: "Platform Notification",
        body: "<p>Hello</p>",
        type: "platform",
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          name: "Hilaq",
          type: "html",
        }),
      );
    });

    it("should throw error for business email without businessId", async () => {
      await expect(
        emailService.send({
          to: "user@example.com",
          subject: "Business Email",
          body: "Hello",
          type: "business",
          // Missing businessId
        }),
      ).rejects.toThrow("Business ID is required");
    });

    it("should send business email with business identity", async () => {
      await emailService.send({
        to: "customer@example.com",
        subject: "Order Confirmation",
        body: "<p>Your order is confirmed</p>",
        type: "business",
        businessId: "business-123",
      });

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "customer@example.com",
          type: "html",
        }),
      );
    });

    it("should throw and log error when send fails", async () => {
      mockSendEmail.mockRejectedValue(new Error("Send failed"));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      await expect(
        emailService.send({
          to: "user@example.com",
          subject: "Test",
          body: "Body",
          type: "platform",
        }),
      ).rejects.toThrow("Send failed");

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
