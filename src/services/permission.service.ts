import { SupabaseClient } from "@supabase/supabase-js";
import { Permission, Role, Membership, SYSTEM_ROLES } from "../types/teams";

export class PermissionService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Get user's membership in a business
   */
  async getMembership(
    userId: string,
    businessId: string,
  ): Promise<Membership | null> {
    const { data, error } = await this.supabase
      .from("memberships")
      .select(
        `
        *,
        role:roles(*)
      `,
      )
      .eq("user_id", userId)
      .eq("business_id", businessId)
      .eq("status", "active")
      .single();

    if (error || !data) return null;
    return data as Membership;
  }

  /**
   * Get all permissions for a role
   */
  async getRolePermissions(roleId: string): Promise<Permission[]> {
    const { data, error } = await this.supabase
      .from("role_permissions")
      .select(
        `
        permission:permissions(*)
      `,
      )
      .eq("role_id", roleId);

    if (error || !data) return [];
    const perms = data.map((rp: any) => rp.permission).filter(Boolean);
    // console.log(`[Permission] Role ${roleId} has permissions:`, perms.map(p => p.key));
    return perms;
  }

  /**
   * Check if user has a specific permission in a business
   * This is the core permission resolution logic
   */
  async hasPermission(
    userId: string,
    businessId: string,
    permissionKey: string,
  ): Promise<boolean> {
    // 1. Check if user is the business owner (owners have all permissions)
    
    // 1. Check if user is the business owner
    const { data: business } = await this.supabase
      .from("businesses")
      .select("owner_user_id")
      .eq("id", businessId)
      .single();

    if (business?.owner_user_id === userId) {
      return true; // Business owner has all permissions
    }

    // 2. Get user's membership
    const membership = await this.getMembership(userId, businessId);

    if (!membership) return false;

    // 3. Check if role is Owner (has all permissions via is_owner flag)
    const role = membership.role;

    if (role?.is_owner) {
      return true;
    }

    // 4. Get role permissions
    const permissions = await this.getRolePermissions(membership.role_id);
    
    // 5. Check for exact permission match
    return permissions.some((p) => p.key === permissionKey);
  }

  /**
   * Check if user has ANY of the specified permissions
   */
  async hasAnyPermission(
    userId: string,
    businessId: string,
    permissionKeys: string[],
  ): Promise<boolean> {
    for (const key of permissionKeys) {
      if (await this.hasPermission(userId, businessId, key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if user has a specific role
   */
  async hasRole(
    userId: string,
    businessId: string,
    roleName: string,
  ): Promise<boolean> {
    const membership = await this.getMembership(userId, businessId);
    if (!membership) return false;
    return membership.role?.name === roleName;
  }

  /**
   * Get all permissions in the system (for UI dropdowns)
   */
  async getAllPermissions(): Promise<Permission[]> {
    const { data, error } = await this.supabase
      .from("permissions")
      .select("*")
      .order("category")
      .order("key");

    if (error) throw error;
    return data || [];
  }

  /**
   * Get permissions grouped by category
   */
  async getPermissionsByCategory(): Promise<Record<string, Permission[]>> {
    const permissions = await this.getAllPermissions();
    return permissions.reduce(
      (acc, perm) => {
        if (!acc[perm.category]) acc[perm.category] = [];
        acc[perm.category].push(perm);
        return acc;
      },
      {} as Record<string, Permission[]>,
    );
  }

  /**
   * Resolve business ID from store ID
   * Helper for middleware that receives store context
   */
  async getBusinessIdFromStore(storeId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("stores")
      .select("business_id")
      .eq("id", storeId)
      .single();

    if (error || !data) return null;
    return data.business_id;
  }

  /**
   * Resolve business ID from product ID
   */
  async getBusinessIdFromProduct(productId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("products")
      .select("store:stores(business_id)")
      .eq("id", productId)
      .single();

    if (error || !data) return null;
    return (data as any).store?.business_id || null;
  }

  /**
   * Resolve business ID from circle ID
   */
  async getBusinessIdFromCircle(circleId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("circles")
      .select("business_id")
      .eq("id", circleId)
      .single();

    if (error || !data) return null;
    return data.business_id;
  }

  /**
   * Check permission with automatic business resolution from store
   */
  async hasPermissionViaStore(
    userId: string,
    storeId: string,
    permissionKey: string,
  ): Promise<boolean> {
    const businessId = await this.getBusinessIdFromStore(storeId);
    if (!businessId) return false;
    return this.hasPermission(userId, businessId, permissionKey);
  }
}
