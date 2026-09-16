import { SupabaseClient } from "@supabase/supabase-js";
import { AUDIT_ACTIONS } from "../types/teams";

export class AuditService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Log an audit event
   */
  async log(params: {
    businessId: string | null;
    actorUserId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const { error } = await this.supabase.from("audit_logs").insert({
      business_id: params.businessId,
      actor_user_id: params.actorUserId,
      action: params.action,
      target_type: params.targetType || null,
      target_id: params.targetId || null,
      metadata: params.metadata || {},
      ip_address: params.ipAddress || null,
      user_agent: params.userAgent || null,
    });

    if (error) {
      console.error("[AuditService] Failed to log event:", error);
      // Don't throw - audit logging should not break business logic
    }
  }

  /**
   * Get audit logs for a business
   */
  async getBusinessLogs(
    businessId: string,
    options?: { limit?: number; offset?: number; action?: string },
  ) {
    let query = this.supabase
      .from("audit_logs")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (options?.action) {
      query = query.eq("action", options.action);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.offset) {
      query = query.range(
        options.offset,
        options.offset + (options.limit || 50) - 1,
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // Convenience methods for common audit events
  async logMemberInvited(
    businessId: string,
    actorId: string,
    inviteeEmail: string,
    roleId: string,
  ) {
    await this.log({
      businessId,
      actorUserId: actorId,
      action: AUDIT_ACTIONS.MEMBER_INVITED,
      targetType: "invitation",
      metadata: { email: inviteeEmail, role_id: roleId },
    });
  }

  async logMemberJoined(
    businessId: string,
    userId: string,
    membershipId: string,
  ) {
    await this.log({
      businessId,
      actorUserId: userId,
      action: AUDIT_ACTIONS.MEMBER_JOINED,
      targetType: "membership",
      targetId: membershipId,
    });
  }

  async logMemberRemoved(
    businessId: string,
    actorId: string,
    removedUserId: string,
    membershipId: string,
  ) {
    await this.log({
      businessId,
      actorUserId: actorId,
      action: AUDIT_ACTIONS.MEMBER_REMOVED,
      targetType: "membership",
      targetId: membershipId,
      metadata: { removed_user_id: removedUserId },
    });
  }

  async logMemberRoleChanged(
    businessId: string,
    actorId: string,
    membershipId: string,
    oldRoleId: string,
    newRoleId: string,
  ) {
    await this.log({
      businessId,
      actorUserId: actorId,
      action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
      targetType: "membership",
      targetId: membershipId,
      metadata: { old_role_id: oldRoleId, new_role_id: newRoleId },
    });
  }

  async logRoleCreated(
    businessId: string,
    actorId: string,
    roleId: string,
    roleName: string,
  ) {
    await this.log({
      businessId,
      actorUserId: actorId,
      action: AUDIT_ACTIONS.ROLE_CREATED,
      targetType: "role",
      targetId: roleId,
      metadata: { name: roleName },
    });
  }

  async logRoleUpdated(businessId: string, actorId: string, roleId: string) {
    await this.log({
      businessId,
      actorUserId: actorId,
      action: AUDIT_ACTIONS.ROLE_UPDATED,
      targetType: "role",
      targetId: roleId,
    });
  }

  async logRoleDeleted(
    businessId: string,
    actorId: string,
    roleId: string,
    roleName: string,
  ) {
    await this.log({
      businessId,
      actorUserId: actorId,
      action: AUDIT_ACTIONS.ROLE_DELETED,
      targetType: "role",
      targetId: roleId,
      metadata: { name: roleName },
    });
  }
}
