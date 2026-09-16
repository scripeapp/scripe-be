import { SupabaseClient } from "@supabase/supabase-js";

export type TicketStatus = "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type TicketCategory = "billing" | "technical" | "feature_request" | "account" | "other";

export class HelpdeskService {
  /**
   * Create a support ticket
   */
  async createTicket(
    supabase: SupabaseClient,
    data: {
      subject: string;
      description: string;
      category: TicketCategory;
      priority?: TicketPriority;
      submitter_id?: string;
      submitter_email?: string;
      business_id?: string;
    },
  ) {
    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .insert({
        ...data,
        priority: data.priority || "medium",
        status: "open",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ticket;
  }

  /**
   * List tickets with filters
   */
  async listTickets(
    supabase: SupabaseClient,
    params: {
      status?: string;
      priority?: string;
      category?: string;
      assigned_to?: string;
      page?: number;
      limit?: number;
      search?: string;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 25;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("support_tickets")
      .select(
        `*, businesses:business_id (name), assigned_admin:assigned_to (email)`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.status && params.status !== "all")
      query = query.eq("status", params.status);
    if (params.priority && params.priority !== "all")
      query = query.eq("priority", params.priority);
    if (params.category && params.category !== "all")
      query = query.eq("category", params.category);
    if (params.assigned_to)
      query = query.eq("assigned_to", params.assigned_to);
    if (params.search)
      query = query.ilike("subject", `%${params.search}%`);

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);
    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Get a single ticket with replies
   */
  async getTicket(supabase: SupabaseClient, id: string) {
    const [ticketRes, repliesRes] = await Promise.all([
      supabase
        .from("support_tickets")
        .select("*, businesses:business_id (name, email)")
        .eq("id", id)
        .single(),
      supabase
        .from("support_ticket_replies")
        .select("*")
        .eq("ticket_id", id)
        .order("created_at", { ascending: true }),
    ]);

    if (ticketRes.error) throw new Error(ticketRes.error.message);
    return { ...ticketRes.data, replies: repliesRes.data || [] };
  }

  /**
   * Update ticket status/assignment
   */
  async updateTicket(
    supabase: SupabaseClient,
    id: string,
    data: {
      status?: TicketStatus;
      priority?: TicketPriority;
      assigned_to?: string;
    },
  ) {
    const updateData: Record<string, any> = { ...data };
    if (data.status === "resolved" || data.status === "closed") {
      updateData.resolved_at = new Date().toISOString();
    }

    const { data: ticket, error } = await supabase
      .from("support_tickets")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return ticket;
  }

  /**
   * Add a reply to a ticket
   */
  async addReply(
    supabase: SupabaseClient,
    ticketId: string,
    data: {
      body: string;
      author_id?: string;
      author_email?: string;
      is_internal?: boolean;
    },
  ) {
    const { data: reply, error } = await supabase
      .from("support_ticket_replies")
      .insert({
        ticket_id: ticketId,
        ...data,
        is_internal: data.is_internal || false,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Move ticket to in_progress if it was open
    await supabase
      .from("support_tickets")
      .update({ status: "in_progress" })
      .eq("id", ticketId)
      .eq("status", "open");

    return reply;
  }

  /**
   * Get helpdesk stats
   */
  async getStats(supabase: SupabaseClient) {
    const statuses = ["open", "in_progress", "waiting_on_user", "resolved", "closed"] as const;
    const results = await Promise.all(
      statuses.map((s) =>
        supabase
          .from("support_tickets")
          .select("id", { count: "exact" })
          .eq("status", s),
      ),
    );

    // Average resolution time (last 30 days)
    const { data: resolvedRecent } = await supabase
      .from("support_tickets")
      .select("created_at, resolved_at")
      .eq("status", "resolved")
      .not("resolved_at", "is", null)
      .gte("resolved_at", new Date(Date.now() - 30 * 86400000).toISOString())
      .limit(100);

    let avgResolutionHours: number | null = null;
    if (resolvedRecent && resolvedRecent.length > 0) {
      const totalHours = resolvedRecent.reduce((sum, t) => {
        const diff =
          new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime();
        return sum + diff / 3600000;
      }, 0);
      avgResolutionHours = Math.round(totalHours / resolvedRecent.length);
    }

    return {
      ...Object.fromEntries(statuses.map((s, i) => [s, results[i].count || 0])),
      avg_resolution_hours: avgResolutionHours,
    };
  }
}

export const helpdeskService = new HelpdeskService();
