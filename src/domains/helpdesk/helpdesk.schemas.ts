import { z } from "zod";

export const ticketParamsSchema = z.object({ ticketId: z.string().uuid() });

export const listQuerySchema = z.object({
  status: z.enum(["open", "in_progress", "waiting_on_user", "resolved", "closed"]).optional(),
});

export const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  category: z.enum(["billing", "technical", "feature_request", "account", "other"]),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  businessId: z.string().uuid().nullable().optional(),
});

export const createReplySchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
