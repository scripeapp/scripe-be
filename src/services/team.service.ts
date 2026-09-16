import { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { AuditService } from "./audit.service";
import {
  SYSTEM_ROLES,
  Role,
  Membership,
  Invitation,
  PosStaff,
  RosterMember,
  TeamRoster,
} from "../types/teams";

export class TeamService {
  private supabase: SupabaseClient;
  private auditService: AuditService;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.auditService = new AuditService(supabase);
  }

  // ============================================================================
  // MEMBERSHIP MANAGEMENT
  // ============================================================================

  /**
   * List all members of a business
   */
  async getMembers(businessId: string) {
    const { data, error } = await this.supabase
      .from("memberships")
      .select(`
        *,
        role:roles(id, name, is_system, is_owner),
        user:user_id(id, email)
      `)
      .eq("business_id", businessId)
      .order("joined_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Unified Team roster: dashboard members (memberships) merged with POS
   * till access (pos_staff), plus PIN-only staff who have no dashboard
   * membership at all. Lets Settings > Team be the single place to manage
   * everyone, while `memberships` and `pos_staff` stay separate tables
   * underneath -- see plan doc "Merge POS Staff into Teams" for why.
   *
   * A business can own more than one store (no unique constraint on
   * stores.business_id), so this aggregates pos_staff across every store
   * under the business rather than assuming exactly one. Each member's
   * `user` also gets its display name/avatar filled in from `users`, since
   * the membership join only exposes email.
   */
  async getTeamRoster(businessId: string): Promise<TeamRoster> {
    const [membershipRows, staffRows] = await Promise.all([
      this.supabase
        .from("memberships")
        .select(`
          *,
          role:roles(id, name, is_system, is_owner),
          user:user_id(id, email)
        `)
        .eq("business_id", businessId)
        .order("joined_at", { ascending: false }),
      this.fetchPosStaffForBusiness(businessId),
    ]);

    const members = (membershipRows.data || []) as Membership[];
    const staff = staffRows as PosStaff[];

    // A membership's user_id is unique per business, so at most one
    // pos_staff row should match it across this business's stores.
    const staffByUserId = new Map<string, PosStaff>();
    const posOnlyStaff: PosStaff[] = [];
    const memberUserIds = new Set(
      members.map((m) => m.user_id).filter((id): id is string => !!id),
    );

    for (const staffRow of staff) {
      if (staffRow.user_id && memberUserIds.has(staffRow.user_id)) {
        if (staffByUserId.has(staffRow.user_id)) {
          // Unexpected: two pos_staff rows sharing a member's user_id.
          // Surface the extra one as posOnly rather than silently dropping it.
          posOnlyStaff.push(staffRow);
        } else {
          staffByUserId.set(staffRow.user_id, staffRow);
        }
      } else {
        posOnlyStaff.push(staffRow);
      }
    }

    const profileById = await this.fetchProfiles(members);

    const rosterMembers: RosterMember[] = members.map((member) => {
      const profile = member.user_id
        ? profileById.get(member.user_id)
        : undefined;
      return {
        ...member,
        user: profile
          ? {
              ...member.user,
              name: profile.name,
              avatar_url: profile.avatar_url,
            }
          : member.user,
        pos: member.user_id ? staffByUserId.get(member.user_id) || null : null,
      } as RosterMember;
    });

    return {
      members: rosterMembers,
      posOnlyStaff,
    };
  }

  /**
   * All till staff across the business's stores, with their branch attached.
   */
  private async fetchPosStaffForBusiness(businessId: string): Promise<PosStaff[]> {
    const { data: storeRows, error: storeError } = await this.supabase
      .from("stores")
      .select("id")
      .eq("business_id", businessId);

    if (storeError) throw storeError;

    const storeIds = (storeRows || []).map((store: any) => store.id);
    if (storeIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from("pos_staff")
      .select(
        "id, store_id, user_id, branch_id, name, status, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .in("store_id", storeIds)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return (data || []).map((row: any): PosStaff => {
      const branch = Array.isArray(row.branch) ? row.branch[0] : row.branch;
      return {
        id: row.id,
        store_id: row.store_id,
        user_id: row.user_id,
        branch_id: row.branch_id,
        name: row.name,
        status: row.status,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        branch: branch || null,
      };
    });
  }

  /**
   * Public profile rows for a set of members so the roster can show each
   * member's display name and avatar (the membership join only exposes email).
   */
  private async fetchProfiles(
    members: Membership[],
  ): Promise<Map<string, { id: string; name: string | null; avatar_url: string | null }>> {
    const userIds = members
      .map((member) => member.user_id)
      .filter((id): id is string => !!id);

    if (userIds.length === 0) return new Map();

    const { data, error } = await this.supabase
      .from("users")
      .select("id, name, avatar_url")
      .in("id", userIds);

    if (error) throw error;

    return new Map(
      (data || []).map((profile) => [profile.id, profile]),
    );
  }

  /**
   * Get a specific membership
   */
  async getMembership(businessId: string, memberId: string) {
    const { data, error } = await this.supabase
      .from("memberships")
      .select(`
        *,
        role:roles(*)
      `)
      .eq("business_id", businessId)
      .eq("id", memberId)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get current user's membership in a business
   */
  async getMyMembership(userId: string, businessId: string) {
    const { data, error } = await this.supabase
      .from("memberships")
      .select(`
        *,
        role:roles(
          *,
          role_permissions (
            permission:permissions(*)
          )
        )
      `)
      .eq("user_id", userId)
      .eq("business_id", businessId)
      .single();

    if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows
    
    // Format data to match Membership type (flatten permissions in role)
    if (data && data.role) {
      return {
        ...data,
        role: {
          ...data.role,
          permissions: data.role.role_permissions?.map((rp: any) => rp.permission).filter(Boolean) || [],
          role_permissions: undefined, // Remove the raw junction data
        }
      };
    }
    
    return data;
  }

  /**
   * Update a member's role
   */
  async updateMemberRole(
    businessId: string,
    memberId: string,
    newRoleId: string,
    actorUserId: string
  ) {
    // Get current membership
    const membership = await this.getMembership(businessId, memberId);
    if (!membership) {
      throw Object.assign(new Error("Membership not found"), { statusCode: 404 });
    }

    // Prevent changing Owner's role
    if (membership.role?.is_owner) {
      throw Object.assign(new Error("Cannot change the Owner's role"), { statusCode: 403 });
    }

    const oldRoleId = membership.role_id;

    // Update role
    const { data, error } = await this.supabase
      .from("memberships")
      .update({ role_id: newRoleId })
      .eq("id", memberId)
      .eq("business_id", businessId)
      .select()
      .single();

    if (error) throw error;

    // Audit log
    await this.auditService.logMemberRoleChanged(businessId, actorUserId, memberId, oldRoleId, newRoleId);

    return data;
  }

  /**
   * Remove a member from a business
   */
  async removeMember(businessId: string, memberId: string, actorUserId: string) {
    // Get membership details
    const membership = await this.getMembership(businessId, memberId);
    if (!membership) {
      throw Object.assign(new Error("Membership not found"), { statusCode: 404 });
    }

    // Prevent removing Owner
    if (membership.role?.is_owner) {
      throw Object.assign(new Error("Cannot remove the Owner"), { statusCode: 403 });
    }

    // Delete membership
    const { error } = await this.supabase
      .from("memberships")
      .delete()
      .eq("id", memberId)
      .eq("business_id", businessId);

    if (error) throw error;

    // Audit log
    await this.auditService.logMemberRemoved(businessId, actorUserId, membership.user_id, memberId);

    return true;
  }

  // ============================================================================
  // INVITATION MANAGEMENT
  // ============================================================================

  /**
   * Send an invitation to join a business
   */
  async sendInvitation(
    businessId: string,
    email: string,
    roleId: string,
    invitedByUserId: string
  ) {
    // Check if user is already a member
    const { data: existingMember } = await this.supabase
      .from("memberships")
      .select("id")
      .eq("business_id", businessId)
      .eq("user_id", (await this.getUserByEmail(email))?.id || "")
      .single();

    if (existingMember) {
      throw Object.assign(new Error("User is already a member of this business"), { statusCode: 409 });
    }

    // Check for existing pending invitation
    const { data: existingInvite } = await this.supabase
      .from("invitations")
      .select("id, revoked_at, accepted_at")
      .eq("business_id", businessId)
      .eq("email", email)
      .single();

    if (existingInvite && !existingInvite.revoked_at && !existingInvite.accepted_at) {
      throw Object.assign(new Error("An invitation is already pending for this email"), { statusCode: 409 });
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Create invitation
    const { data, error } = await this.supabase
      .from("invitations")
      .upsert({
        business_id: businessId,
        email,
        role_id: roleId,
        token,
        invited_by: invitedByUserId,
        expires_at: expiresAt.toISOString(),
        accepted_at: null,
        revoked_at: null,
      }, { onConflict: "business_id,email" })
      .select()
      .single();

    if (error) throw error;

    // Audit log
    await this.auditService.logMemberInvited(businessId, invitedByUserId, email, roleId);

    // Fetch details for email personalization
    const [
      { data: inviter },
      { data: business },
      { data: inviteeProfile }
    ] = await Promise.all([
      this.supabase.from("users").select("name").eq("id", invitedByUserId).single(),
      this.supabase.from("businesses").select("name").eq("id", businessId).single(),
      this.supabase.from("users").select("name").eq("email", email).single()
    ]);

    const inviterName = inviter?.name || "A team member";
    const businessName = business?.name || "their business";
    const inviteeName = inviteeProfile?.name || "there";
    const invitationLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/accept-invite?token=${token}`;

    // Send email via Plunk
    try {
      const { notificationService } = await import("./notification.services");
      const emailsTemplate = (await import("../utils/emailsTemplate")).default;
      
      const emailBody = emailsTemplate.teamInvitationEmail({
        inviterName,
        businessName,
        inviteeName,
        invitationLink,
      });

      await notificationService.createNotification({
        toEmail: email,
        emailName: "Hilaq Team",
        emailSubject: `You've been invited to join ${businessName} on Hilaq`,
        emailBody,
      });
    } catch (emailError) {
      console.error("[TeamService.sendInvitation] Failed to send email:", emailError);
      // We don't throw here to avoid failing the invitation creation if only email fails
    }

    return { ...data, invitationLink };
  }

  /**
   * Accept an invitation
   */
  async acceptInvitation(token: string, userId: string) {
    // Find invitation
    const { data: invitation, error: fetchError } = await this.supabase
      .from("invitations")
      .select("*")
      .eq("token", token)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .single();

    if (fetchError || !invitation) {
      throw Object.assign(new Error("Invalid or expired invitation"), { statusCode: 400 });
    }

    // Check expiry
    if (new Date(invitation.expires_at) < new Date()) {
      throw Object.assign(new Error("Invitation has expired"), { statusCode: 400 });
    }

    // Create membership
    const { data: membership, error: memberError } = await this.supabase
      .from("memberships")
      .insert({
        user_id: userId,
        business_id: invitation.business_id,
        role_id: invitation.role_id,
        status: "active",
        joined_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (memberError) throw memberError;

    // Mark invitation as accepted
    await this.supabase
      .from("invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    // Audit log
    await this.auditService.logMemberJoined(invitation.business_id, userId, membership.id);

    return membership;
  }

  /**
   * Revoke an invitation
   */
  async revokeInvitation(businessId: string, invitationId: string, actorUserId: string) {
    const { error } = await this.supabase
      .from("invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", invitationId)
      .eq("business_id", businessId);

    if (error) throw error;

    // Audit log
    await this.auditService.log({
      businessId,
      actorUserId,
      action: "invitation.revoked",
      targetType: "invitation",
      targetId: invitationId,
    });

    return true;
  }

  /**
   * Get pending invitations for a business
   */
  async getPendingInvitations(businessId: string) {
    const { data, error } = await this.supabase
      .from("invitations")
      .select(`
        *,
        role:roles(id, name)
      `)
      .eq("business_id", businessId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // ============================================================================
  // ROLE MANAGEMENT
  // ============================================================================

  /**
   * Get all roles available to a business (system + custom)
   */
  async getRoles(businessId: string) {
    const { data, error } = await this.supabase
      .from("roles")
      .select(`
        *,
        role_permissions (
          permission:permissions(*)
        )
      `)
      .or(`is_system.eq.true,business_id.eq.${businessId}`)
      .order("is_system", { ascending: false })
      .order("name");

    if (error) throw error;
    
    // Format data to match Role type (flatten permissions)
    return (data || []).map((role: any) => ({
      ...role,
      permissions: role.role_permissions?.map((rp: any) => rp.permission).filter(Boolean) || [],
      role_permissions: undefined, // Remove the raw junction data
    }));
  }

  /**
   * Get a role with its permissions
   */
  async getRoleWithPermissions(roleId: string) {
    const { data: role, error: roleError } = await this.supabase
      .from("roles")
      .select("*")
      .eq("id", roleId)
      .single();

    if (roleError) throw roleError;

    const { data: permissions, error: permError } = await this.supabase
      .from("role_permissions")
      .select("permission:permissions(*)")
      .eq("role_id", roleId);

    if (permError) throw permError;

    return {
      ...role,
      permissions: permissions?.map((rp: any) => rp.permission).filter(Boolean) || [],
    };
  }

  /**
   * Create a custom role
   */
  async createRole(
    businessId: string,
    name: string,
    permissionIds: string[],
    createdByUserId: string
  ) {
    // Create role
    const { data: role, error: roleError } = await this.supabase
      .from("roles")
      .insert({
        business_id: businessId,
        name,
        is_system: false,
        is_owner: false,
        created_by: createdByUserId,
      })
      .select()
      .single();

    if (roleError) throw roleError;

    // Assign permissions
    if (permissionIds.length > 0) {
      const rolePermissions = permissionIds.map((pid) => ({
        role_id: role.id,
        permission_id: pid,
      }));

      const { error: permError } = await this.supabase
        .from("role_permissions")
        .insert(rolePermissions);

      if (permError) throw permError;
    }

    // Audit log
    await this.auditService.logRoleCreated(businessId, createdByUserId, role.id, name);

    return this.getRoleWithPermissions(role.id);
  }

  /**
   * Update a custom role
   */
  async updateRole(
    roleId: string,
    updates: { name?: string; permissionIds?: string[] },
    actorUserId: string
  ) {
    // Get existing role
    const { data: role } = await this.supabase
      .from("roles")
      .select("*")
      .eq("id", roleId)
      .single();

    if (!role) {
      throw Object.assign(new Error("Role not found"), { statusCode: 404 });
    }

    if (role.is_system) {
      throw Object.assign(new Error("Cannot modify system roles"), { statusCode: 403 });
    }

    // Update name if provided
    if (updates.name) {
      const { error } = await this.supabase
        .from("roles")
        .update({ name: updates.name })
        .eq("id", roleId);

      if (error) throw error;
    }

    // Update permissions if provided
    if (updates.permissionIds) {
      // Delete existing permissions
      await this.supabase
        .from("role_permissions")
        .delete()
        .eq("role_id", roleId);

      // Insert new permissions
      if (updates.permissionIds.length > 0) {
        const rolePermissions = updates.permissionIds.map((pid) => ({
          role_id: roleId,
          permission_id: pid,
        }));

        const { error } = await this.supabase
          .from("role_permissions")
          .insert(rolePermissions);

        if (error) throw error;
      }
    }

    // Audit log
    await this.auditService.logRoleUpdated(role.business_id, actorUserId, roleId);

    return this.getRoleWithPermissions(roleId);
  }

  /**
   * Delete a custom role
   */
  async deleteRole(roleId: string, actorUserId: string) {
    // Get role
    const { data: role } = await this.supabase
      .from("roles")
      .select("*")
      .eq("id", roleId)
      .single();

    if (!role) {
      throw Object.assign(new Error("Role not found"), { statusCode: 404 });
    }

    if (role.is_system) {
      throw Object.assign(new Error("Cannot delete system roles"), { statusCode: 403 });
    }

    // Check if role is in use
    const { data: memberships } = await this.supabase
      .from("memberships")
      .select("id")
      .eq("role_id", roleId)
      .limit(1);

    if (memberships && memberships.length > 0) {
      throw Object.assign(new Error("Cannot delete role that is assigned to members"), { statusCode: 409 });
    }

    // Delete role (cascade will handle role_permissions)
    const { error } = await this.supabase.from("roles").delete().eq("id", roleId);

    if (error) throw error;

    // Audit log
    await this.auditService.logRoleDeleted(role.business_id, actorUserId, roleId, role.name);

    return true;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private async getUserByEmail(email: string) {
    const { data } = await this.supabase
      .from("auth.users")
      .select("id")
      .eq("email", email)
      .single();
    return data;
  }
}
