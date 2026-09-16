import { SupabaseClient } from "@supabase/supabase-js";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";

export type AdminRole =
  | "super_admin"
  | "support"
  | "finance"
  | "moderator"
  | "viewer";

export interface AdminUser {
  id: string;
  user_id: string;
  role: AdminRole;
  name: string;
  email: string;
  is_active: boolean;
  permissions: string[];
}

export class AdminService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Fetches an admin user record by their auth user ID
   */
  async getAdminUser(userId: string): Promise<AdminUser | null> {
    console.log(`[AdminService] Fetching admin record for user_id: ${userId}`);

    // Check if we are using the service role or not
    const isServiceRole =
      (this.supabase as any).supabaseKey?.length > 100 &&
      !(this.supabase as any).supabaseKey.includes("anon");
    console.log(`[AdminService] Using Service Role: ${isServiceRole}`);

    const { data, error } = await this.supabase
      .from("admin_users")
      .select("*")
      .eq("user_id", userId)
      .eq("is_active", true)
      .single();

    if (error) {
      console.error(
        `[AdminService] Error fetching admin user:`,
        error.message,
        error.details,
      );
      return null;
    }

    if (!data) {
      console.warn(
        `[AdminService] No active admin record found for user_id: ${userId}`,
      );
      return null;
    }

    console.log(
      `[AdminService] Successfully found admin: ${data.name} (Role: ${data.role})`,
    );
    return data as AdminUser;
  }

  /**
   * Checks if an admin has a specific internal role or higher
   */
  hasRole(currentRole: AdminRole, requiredRole: AdminRole): boolean {
    const roles: AdminRole[] = [
      "viewer",
      "moderator",
      "support",
      "finance",
      "super_admin",
    ];
    const currentIndex = roles.indexOf(currentRole);
    const requiredIndex = roles.indexOf(requiredRole);

    return currentIndex >= requiredIndex;
  }

  /**
   * Checks if an admin has a specific permission key or is a super_admin
   */
  hasPermission(admin: AdminUser, permission: string): boolean {
    if (admin.role === "super_admin") return true;
    if (!Array.isArray(admin.permissions)) return false;
    return admin.permissions.includes(permission);
  }

  /**
   * Logs an admin action to the audit chain
   */
  async logAction(params: {
    adminUserId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    beforeData?: any;
    afterData?: any;
    reason?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const { error } = await this.supabase.from("admin_audit_logs").insert([
      {
        admin_user_id: params.adminUserId,
        action: params.action,
        target_type: params.targetType,
        target_id: params.targetId,
        before_data: params.beforeData,
        after_data: params.afterData,
        reason: params.reason,
        ip_address: params.ipAddress,
        user_agent: params.userAgent,
      },
    ]);

    if (error) {
      console.error("Failed to log admin action:", error);
    }
  }

  /**
   * Upgrades a business subscription to a specified plan
   */
  async upgradeBusinessSubscription(
    businessId: string,
    plan: "starter" | "plus" | "pro",
    adminUserId: string,
  ): Promise<{
    success: boolean;
    message: string;
    business?: any;
    error?: string;
  }> {
    try {
      // 1. Find business by ID
      const { data: business, error: findError } = await this.supabase
        .from("businesses")
        .select(
          "id, name, subscription_plan, subscription_status, subscription_meta, subscription_started_at",
        )
        .eq("id", businessId)
        .single();

      if (findError && findError.code !== "PGRST116") throw findError;
      if (!business) {
        return {
          success: false,
          message: `No business found with ID: ${businessId}`,
          error: "NOT_FOUND",
        };
      }

      // 2. Check if already on the target plan and active
      if (
        business.subscription_plan === plan &&
        business.subscription_status === "active"
      ) {
        return {
          success: true,
          message: `Business is already on the ${plan} plan`,
          business,
        };
      }

      const now = new Date().toISOString();
      const reference = createTransactionReference(REFERENCE_TYPES.SUBSCRIPTION);
      const updatedMeta = {
        ...(business.subscription_meta || {}),
        provider: "admin_manual",
        plan_normalized: plan,
        last_reference: reference,
        upgraded_by: adminUserId,
        upgraded_at: now,
      };

      // 3. Update business subscription
      const { data: updatedBusiness, error: updateError } = await this.supabase
        .from("businesses")
        .update({
          subscription_plan: plan,
          subscription_status: "active",
          subscription_reference: reference,
          subscription_updated_at: now,
          subscription_started_at: business.subscription_started_at || now,
          subscription_meta: updatedMeta,
        })
        .eq("id", businessId)
        .select()
        .single();

      if (updateError) throw updateError;

      // 4. Log the audit action
      await this.logAction({
        adminUserId: adminUserId,
        action: "business.upgrade_subscription",
        targetType: "business",
        targetId: businessId,
        beforeData: {
          plan: business.subscription_plan,
          status: business.subscription_status,
        },
        afterData: { plan, status: "active" },
        reason: `Manual admin upgrade to ${plan}`,
      });

      return {
        success: true,
        message: `Successfully upgraded ${business.name || businessId} to ${plan}`,
        business: updatedBusiness,
      };
    } catch (error: any) {
      console.error(
        "[AdminService] Failed to upgrade business subscription:",
        error,
      );
      return {
        success: false,
        message: error.message || "Failed to upgrade business",
        error: "SERVER_ERROR",
      };
    }
  }

  /**
   * List all subscription plans with their limits and features
   */
  async listPlans() {
    const { data, error } = await this.supabase
      .from("plan_limits")
      .select("*")
      .order("price_monthly", { ascending: true });

    if (error) throw error;
    return data;
  }

  /**
   * Get a single subscription plan by ID
   */
  async getPlan(id: string) {
    const { data, error } = await this.supabase
      .from("plan_limits")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update a subscription plan's configuration
   */
  async updatePlan(id: string, updates: any, adminUserId: string) {
    // 1. Get current plan data for audit log
    const { data: beforeData, error: fetchError } = await this.supabase
      .from("plan_limits")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;

    // 2. Perform update
    const { data: updatedPlan, error: updateError } = await this.supabase
      .from("plan_limits")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    // 3. Log the audit action
    await this.logAction({
      adminUserId,
      action: "plan.update",
      targetType: "plan_limits",
      targetId: id,
      beforeData,
      afterData: updatedPlan,
      reason: `Admin updated plan ${beforeData.plan}`,
    });

    return updatedPlan;
  }

  /**
   * Get statistics on how many businesses are on each plan
   */
  async getPlanStats() {
    const { data, error } = await this.supabase
      .from("businesses")
      .select("subscription_plan");

    if (error) throw error;

    const stats: Record<string, number> = {
      starter: 0,
      plus: 0,
      pro: 0,
    };

    data.forEach((b: any) => {
      const plan = b.subscription_plan || "starter";
      stats[plan] = (stats[plan] || 0) + 1;
    });

    return stats;
  }

  /**
   * Create a new custom plan (Advanced)
   */
  async createPlan(planData: any, adminUserId: string) {
    const { data, error } = await this.supabase
      .from("plan_limits")
      .insert([planData])
      .select()
      .single();

    if (error) throw error;

    await this.logAction({
      adminUserId,
      action: "plan.create",
      targetType: "plan_limits",
      targetId: data.id,
      afterData: data,
      reason: `Admin created new plan ${data.plan}`,
    });

    return data;
  }

  /**
   * Delete a custom plan (Advanced)
   */
  async deletePlan(id: string, adminUserId: string) {
    // Check if any business is using this plan
    const { data: planData } = await this.supabase
      .from("plan_limits")
      .select("plan")
      .eq("id", id)
      .single();

    if (planData) {
      const { count } = await this.supabase
        .from("businesses")
        .select("*", { count: "exact", head: true })
        .eq("subscription_plan", planData.plan);

      if (count && count > 0) {
        throw new Error(
          `Cannot delete plan ${planData.plan} as it is currently being used by ${count} businesses.`,
        );
      }
    }

    const { error } = await this.supabase
      .from("plan_limits")
      .delete()
      .eq("id", id);

    if (error) throw error;

    await this.logAction({
      adminUserId,
      action: "plan.delete",
      targetType: "plan_limits",
      targetId: id,
      reason: `Admin deleted plan ${planData?.plan || id}`,
    });

    return true;
  }
}
