import { scheduledEmailService } from "../services/scheduled-email.service";
import { supabaseAdmin } from "../config/supabase";
import { emailService } from "../services/email.service";

// Mock dependencies
jest.mock("../config/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
    }),
  },
}));

jest.mock("../services/email.service", () => ({
  emailService: {
    send: jest.fn().mockResolvedValue(undefined),
  },
}));

describe("ScheduledEmailService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("schedule", () => {
    it("should insert a new record into scheduled_emails table", async () => {
      const options = {
        to: "test@example.com",
        subject: "Test Subject",
        body: "Test Body",
        type: "platform" as const,
        scheduledAt: new Date(Date.now() + 3600000), // 1 hour later
      };

      const mockInsert = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        insert: mockInsert,
      });

      await scheduledEmailService.schedule(options);

      expect(supabaseAdmin.from).toHaveBeenCalledWith("scheduled_emails");
      expect(mockInsert).toHaveBeenCalledWith([
        expect.objectContaining({
          recipient_email: options.to,
          subject: options.subject,
          scheduled_at: options.scheduledAt.toISOString(),
          status: "pending",
        }),
      ]);
    });

    it("should throw error if insert fails", async () => {
      const mockInsert = jest.fn().mockResolvedValue({ error: { message: "DB Error" } });
      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        insert: mockInsert,
      });

      await expect(
        scheduledEmailService.schedule({
          to: "test@example.com",
          subject: "Test",
          body: "Body",
          type: "platform",
          scheduledAt: new Date(),
        })
      ).rejects.toEqual({ message: "DB Error" });
    });
  });

  describe("processDueEmails", () => {
    it("should process due emails and update their status", async () => {
      const mockEmails = [
        {
          id: "1",
          recipient_email: "user1@example.com",
          subject: "Welcome 1",
          body: "Body 1",
          email_type: "platform",
          status: "pending",
        },
      ];

      const mockSelect = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockReturnThis();
      const mockLte = jest.fn().mockReturnThis();
      const mockLimit = jest.fn().mockResolvedValue({ data: mockEmails, error: null });
      const mockUpdate = jest.fn();
      const mockClaimSingle = jest.fn().mockResolvedValue({ data: mockEmails[0], error: null });
      const mockClaimSelect = jest.fn().mockReturnValue({ single: mockClaimSingle });
      const mockClaimEqStatus = jest.fn().mockReturnValue({ select: mockClaimSelect });
      const mockClaimEqId = jest.fn().mockReturnValue({ eq: mockClaimEqStatus });
      const mockSentEq = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin.from as jest.Mock).mockImplementation((table) => {
        if (table === "scheduled_emails") {
          return {
            select: mockSelect,
            eq: mockEq,
            lte: mockLte,
            limit: mockLimit,
            update: mockUpdate,
          };
        }
        return {};
      });

      mockUpdate
        .mockReturnValueOnce({ eq: mockClaimEqId })
        .mockReturnValueOnce({ eq: mockSentEq });

      await scheduledEmailService.processDueEmails();

      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user1@example.com",
          subject: "Welcome 1",
        })
      );

      expect(mockUpdate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          status: "sent",
        })
      );
      expect(mockSentEq).toHaveBeenCalledWith("id", "1");
    });

    it("should mark email as failed if sending fails", async () => {
      const mockEmails = [
        {
          id: "2",
          recipient_email: "fail@example.com",
          subject: "Fail",
          body: "Body",
          email_type: "platform",
          status: "pending",
          retry_count: 0,
        },
      ];

      (emailService.send as jest.Mock).mockRejectedValue(new Error("Network Error"));

      const mockUpdate = jest.fn();
      const mockClaimSingle = jest.fn().mockResolvedValue({ data: mockEmails[0], error: null });
      const mockClaimSelect = jest.fn().mockReturnValue({ single: mockClaimSingle });
      const mockClaimEqStatus = jest.fn().mockReturnValue({ select: mockClaimSelect });
      const mockClaimEqId = jest.fn().mockReturnValue({ eq: mockClaimEqStatus });
      const mockFailedEq = jest.fn().mockResolvedValue({ error: null });

      (supabaseAdmin.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: mockEmails, error: null }),
        update: mockUpdate,
      });

      mockUpdate
        .mockReturnValueOnce({ eq: mockClaimEqId })
        .mockReturnValueOnce({ eq: mockFailedEq });

      await scheduledEmailService.processDueEmails();

      expect(mockUpdate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          status: "failed",
          error_message: "Network Error",
          retry_count: 1,
        })
      );
    });
  });
});
