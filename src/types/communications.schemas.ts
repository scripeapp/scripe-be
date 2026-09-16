import { z } from "zod";

// ============================================================================
// Communications API Validation Schemas
// ============================================================================

export const communicationsSchemas = {
  // ============================================================================
  // Domains
  // ============================================================================

  addDomain: z.object({
    domain: z.string().min(1, "Domain is required").max(255).regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z]{2,})+$/,
      "Invalid domain format"
    ),
  }),

  domainIdParam: z.object({
    id: z.string().uuid("Invalid domain ID"),
  }),

  // ============================================================================
  // Senders
  // ============================================================================

  createSender: z.object({
    name: z.string().min(1, "Name is required").max(100),
    email: z.string().email("Invalid email format").max(255),
    domain_id: z.string().uuid().optional(),
  }),

  updateSender: z.object({
    name: z.string().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
    used_by: z.array(z.string()).optional(),
  }),

  senderIdParam: z.object({
    id: z.string().uuid("Invalid sender ID"),
  }),
};

export default communicationsSchemas;
