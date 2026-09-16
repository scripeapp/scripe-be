import { z } from "zod";

export const eventSchemas = {
  initiateCheckout: z.object({
    event_id: z.string().uuid("Invalid event ID"),
    customer: z.object({
      full_name: z.string().min(1, "Name is required"),
      email: z.string().email("Invalid email"),
      phone_number: z.string().optional(),
      gender: z.string().optional(),
      custom_answers: z.record(z.string(), z.string()).optional(),
    }),
    selectedTickets: z.record(z.string(), z.number().int().positive()), // { "<ticket-uuid>": quantity }
    recipients: z.array(z.object({
      full_name: z.string().optional(),
      email: z.string().email().optional(),
      phone_number: z.string().optional(),
      gender: z.string().optional(),
      custom_answers: z.record(z.string(), z.string()).optional(),
      ticketId: z.string().uuid()
    })).optional(),
    callback_url: z.string().url().optional(),
  })
};
