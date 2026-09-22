import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const membershipParamsSchema = businessParamsSchema.extend({
  membershipId: z.string().uuid(),
});

export const roleParamsSchema = businessParamsSchema.extend({
  roleId: z.string().uuid(),
});

export const invitationParamsSchema = businessParamsSchema.extend({
  invitationId: z.string().uuid(),
});

export const acceptInvitationParamsSchema = z.object({ token: z.string().min(1) });

const emailField = z.string().trim().email().toLowerCase();

export const inviteMembersSchema = z.object({
  emails: z.array(emailField).min(1).max(25),
  roleId: z.string().uuid(),
});

export const setMemberRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(20),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  permissionIds: z.array(z.string().uuid()).default([]),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    permissionIds: z.array(z.string().uuid()).optional(),
  })
  .refine((value) => value.name !== undefined || value.permissionIds !== undefined, {
    message: "At least one field is required",
  });
