import { z } from "zod";

// ============================================================================
// Permission Schema
// ============================================================================
export const PermissionSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1).max(100), // e.g., store.product.create
  category: z.string().min(1).max(50),
  description: z.string().nullable(),
  created_at: z.string(),
});

export type Permission = z.infer<typeof PermissionSchema>;

// ============================================================================
// Role Schema
// ============================================================================
export const RoleSchema = z.object({
  id: z.string().uuid(),
  business_id: z.string().uuid().nullable(), // Null for system roles
  name: z.string().min(1).max(100),
  is_system: z.boolean().default(false),
  is_owner: z.boolean().default(false),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // Joined data
  permissions: z.array(PermissionSchema).optional(),
});

export type Role = z.infer<typeof RoleSchema>;

// ============================================================================
// Membership Schema
// ============================================================================
export const MembershipSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid().nullable(), // Null if pending invite
  business_id: z.string().uuid(),
  role_id: z.string().uuid(),
  status: z.enum(["active", "invited", "suspended"]),
  invited_at: z.string().nullable(),
  joined_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // Joined data
  role: RoleSchema.optional(),
  user: z.object({ email: z.string().email() }).optional(),
});

export type Membership = z.infer<typeof MembershipSchema>;

// ============================================================================
// POS Staff Schema — till PIN access, a separate table from Membership. A
// staff member either links to a dashboard member via user_id or exists
// standalone (till access with no dashboard login at all).
// ============================================================================
export const PosStaffSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  user_id: z.string().uuid().nullable(),
  branch_id: z.string().uuid().nullable(),
  name: z.string(),
  status: z.enum(["active", "inactive"]),
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  // Joined data
  branch: z
    .object({ id: z.string().uuid(), name: z.string() })
    .nullable()
    .optional(),
});

export type PosStaff = z.infer<typeof PosStaffSchema>;

/** A dashboard member merged with its till access, if it has any. */
export interface RosterMember extends Membership {
  pos: PosStaff | null;
}

/** Profile data attached to a roster member's linked user. */
export interface RosterMemberUser {
  id?: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
}

/** Response shape of GET /teams/businesses/:businessId/roster. */
export interface TeamRoster {
  members: RosterMember[];
  posOnlyStaff: PosStaff[];
}

// ============================================================================
// Invitation Schema
// ============================================================================
export const InvitationSchema = z.object({
  id: z.string().uuid(),
  business_id: z.string().uuid(),
  email: z.string().email(),
  role_id: z.string().uuid(),
  token: z.string(),
  invited_by: z.string().uuid(),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export type Invitation = z.infer<typeof InvitationSchema>;

// ============================================================================
// Business Schema
// ============================================================================
export const BusinessSchema = z.object({
  id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).nullable().optional(),
  status: z.enum(["active", "suspended", "deleted"]),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Business = z.infer<typeof BusinessSchema>;

// ============================================================================
// Audit Log Schema
// ============================================================================
export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  business_id: z.string().uuid(),
  actor_user_id: z.string().uuid().nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.any()).default({}),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  created_at: z.string(),
});

export type AuditLog = z.infer<typeof AuditLogSchema>;

// ============================================================================
// API Input Schemas
// ============================================================================

export const CreateInvitationInput = z
  .object({
    email: z.string().email("Invalid email address").optional(),
    emails: z.array(z.string().email("Invalid email address")).optional(),
    role_id: z.string().uuid("Invalid role ID"),
  })
  .refine((data) => data.email || (data.emails && data.emails.length > 0), {
    message: "Either 'email' or 'emails' must be provided",
  });

export const AcceptInvitationInput = z.object({
  token: z.string().min(1, "Token is required"),
});

export const UpdateMemberRoleInput = z.object({
  role_id: z.string().uuid("Invalid role ID"),
});

export const CreateRoleInput = z.object({
  name: z.string().min(1, "Role name is required").max(100),
  permission_ids: z.array(z.string().uuid()).default([]),
});

export const UpdateRoleInput = z.object({
  name: z.string().min(1).max(100).optional(),
  permission_ids: z.array(z.string().uuid()).optional(),
});

export const CreateBusinessInput = z.object({
  name: z.string().min(1, "Business name is required").max(255),
});

// ============================================================================
// System Role Names (Constants)
// ============================================================================
export const SYSTEM_ROLES = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  STAFF: "Staff",
  VIEWER: "Viewer",
} as const;

// ============================================================================
// Audit Action Names (Constants)
// ============================================================================
export const AUDIT_ACTIONS = {
  MEMBER_INVITED: "member.invited",
  MEMBER_JOINED: "member.joined",
  MEMBER_REMOVED: "member.removed",
  MEMBER_ROLE_CHANGED: "member.role_changed",
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  OWNERSHIP_TRANSFERRED: "ownership.transferred",
  INVITATION_REVOKED: "invitation.revoked",
} as const;
