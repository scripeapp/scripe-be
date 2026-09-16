/**
 * System Announcements Service
 * Platform-wide announcements pushed by admins to all users or specific segments
 */

import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";

export type AnnouncementAudience = "all" | "pro" | "plus" | "starter" | "paid";
export type AnnouncementType = "info" | "warning" | "feature" | "maintenance" | "changelog";

export interface SystemAnnouncement {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  audience: AnnouncementAudience;
  is_active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  type: AnnouncementType;
  audience: AnnouncementAudience;
  is_active?: boolean;
  starts_at?: string;
  expires_at?: string;
  created_by?: string;
}

export class SystemAnnouncementsService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  /**
   * Create a new platform-wide announcement
   */
  async create(
    supabase: SupabaseClient | undefined,
    input: CreateAnnouncementInput,
  ): Promise<SystemAnnouncement> {
    const client = this.getClient(supabase);

    const { data, error } = await client
      .from("system_announcements")
      .insert({
        title: input.title,
        body: input.body,
        type: input.type,
        audience: input.audience,
        is_active: input.is_active ?? true,
        starts_at: input.starts_at || null,
        expires_at: input.expires_at || null,
        created_by: input.created_by || null,
      })
      .select()
      .single();

    if (error) throw error;
    return data as SystemAnnouncement;
  }

  /**
   * Update an existing announcement
   */
  async update(
    supabase: SupabaseClient | undefined,
    id: string,
    input: Partial<CreateAnnouncementInput> & { is_active?: boolean },
  ): Promise<SystemAnnouncement> {
    const client = this.getClient(supabase);

    const { data, error } = await client
      .from("system_announcements")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as SystemAnnouncement;
  }

  /**
   * Delete an announcement
   */
  async delete(supabase: SupabaseClient | undefined, id: string): Promise<void> {
    const client = this.getClient(supabase);
    const { error } = await client.from("system_announcements").delete().eq("id", id);
    if (error) throw error;
  }

  /**
   * List all announcements (admin view — all statuses)
   */
  async list(
    supabase: SupabaseClient | undefined,
    options: { page?: number; limit?: number; active_only?: boolean } = {},
  ): Promise<{ data: SystemAnnouncement[]; total: number }> {
    const client = this.getClient(supabase);
    const { page = 1, limit = 20, active_only } = options;
    const offset = (page - 1) * limit;

    let query = client
      .from("system_announcements")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (active_only) query = query.eq("is_active", true);

    const { data, count, error } = await query;
    if (error) throw error;

    return { data: (data || []) as SystemAnnouncement[], total: count || 0 };
  }

  /**
   * Get active announcements for a specific business plan (for end-user display)
   */
  async getActiveForPlan(
    supabase: SupabaseClient | undefined,
    plan: string,
  ): Promise<SystemAnnouncement[]> {
    const client = this.getClient(supabase);
    const now = new Date().toISOString();

    const audiences: AnnouncementAudience[] = ["all"];
    if (plan !== "starter") audiences.push("paid");
    if (plan === "plus") audiences.push("plus");
    if (plan === "pro") audiences.push("pro");

    const { data, error } = await client
      .from("system_announcements")
      .select("*")
      .eq("is_active", true)
      .in("audience", audiences)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`expires_at.is.null,expires_at.gte.${now}`)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw error;
    return (data || []) as SystemAnnouncement[];
  }
}

export const systemAnnouncementsService = new SystemAnnouncementsService();
