import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { AdminService } from "../services/admin.service";
import ApiResponse from "../utils/apiResponse";
import supabaseAdmin from "../config/supabaseAdmin";
import { cacheGet, cacheSet, cacheDel } from "../config/redis";
import {
  listPaystackSettlements,
  listPaystackTransactions,
  getPaystackTransfer,
} from "../utils/paystack.util";
import { BankingService } from "../services/banking.service";
import type { SupabaseClient } from "@supabase/supabase-js";
import pendingCheckoutService from "../services/pending-checkout.service";
import { PaymentProviderFactory } from "../utils/payment/PaymentProviderFactory";

const ADMIN_STATS_CACHE_KEY = "admin_stats";
const ADMIN_STATS_TTL = 120; // 2 minutes

export class AdminController {
  /**
   * Get the admin Supabase client (service role) for bypassing RLS.
   * Falls back to user's client if admin client is not available.
   */
  private getAdminClient(req: SupabaseRequest) {
    return supabaseAdmin || req.supabase;
  }

  /**
   * Get platform-wide overview statistics
   */
  async getStats(req: SupabaseRequest, res: Response) {
    try {
      const adminClient = this.getAdminClient(req);

      const cached = await cacheGet<{ stats: unknown; activities: unknown[] }>(
        ADMIN_STATS_CACHE_KEY,
      );
      if (cached) {
        return ApiResponse.success(
          res,
          "Platform statistics retrieved successfully",
          cached,
        );
      }

      const { data: stats, error: statsError } =
        await req.supabase.rpc("get_admin_stats");

      if (statsError) throw statsError;

      const activities = await this.fetchRecentActivities(adminClient);
      const payload = { stats, activities };
      await cacheSet(ADMIN_STATS_CACHE_KEY, payload, ADMIN_STATS_TTL);

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "dashboard.view_stats",
          targetType: "platform",
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return ApiResponse.success(
        res,
        "Platform statistics retrieved successfully",
        payload,
      );
    } catch (error: any) {
      console.error("Failed to fetch admin stats:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch admin statistics",
      );
    }
  }

  /**
   * Helper to fetch platform-wide activities for the dashboard
   */
  private async fetchRecentActivities(adminClient: any) {
    try {
      const [
        { data: users },
        { data: businesses },
        { data: stores },
        { data: orders },
        { data: logs },
      ] = await Promise.all([
        adminClient
          .from("users")
          .select("id, name, created_at")
          .order("created_at", { ascending: false })
          .limit(3),
        adminClient
          .from("businesses")
          .select("id, name, created_at")
          .order("created_at", { ascending: false })
          .limit(2),
        adminClient
          .from("stores")
          .select("id, name, created_at")
          .order("created_at", { ascending: false })
          .limit(2),
        adminClient
          .from("store_orders")
          .select("id, order_number, total, created_at")
          .order("created_at", { ascending: false })
          .limit(5),
        adminClient
          .from("admin_audit_logs")
          .select("id, action, target_type, created_at")
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

      const activities: any[] = [];

      (users || []).forEach((u: any) =>
        activities.push({
          id: `user-${u.id}`,
          type: "user_registration",
          label: "New User Registered",
          description: `User ${u.name || "someone"} joined the platform.`,
          timestamp: u.created_at,
        }),
      );

      (businesses || []).forEach((b: any) =>
        activities.push({
          id: `biz-${b.id}`,
          type: "business_onboarding",
          label: "New Business Onboarded",
          description: `"${b.name}" was successfully onboarded.`,
          timestamp: b.created_at,
        }),
      );

      (stores || []).forEach((s: any) =>
        activities.push({
          id: `store-${s.id}`,
          type: "store_creation",
          label: "New Store Opened",
          description: `Store "${s.name}" is now live.`,
          timestamp: s.created_at,
        }),
      );

      (orders || []).forEach((o: any) =>
        activities.push({
          id: `order-${o.id}`,
          type: "order_placed",
          label: "New Order Placed",
          description: `Order #${o.order_number || o.id.slice(0, 8)} for ₦${Number(o.total || 0).toLocaleString()} was placed.`,
          timestamp: o.created_at,
        }),
      );

      (logs || []).forEach((l: any) =>
        activities.push({
          id: `log-${l.id}`,
          type: "admin_action",
          label: "Admin Action",
          description: `Performed ${l.action.replace(/\./g, " ")} on ${l.target_type}.`,
          timestamp: l.created_at,
        }),
      );

      return activities
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        .slice(0, 10);
    } catch (e) {
      console.error("[Admin] Activity fetch failed:", e);
      return [];
    }
  }

  /**
   * Get admin action logs (Audit Trail)
   */
  async getAuditLogs(req: SupabaseRequest, res: Response) {
    try {
      const { page = 1, limit = 50 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      const { data, count, error } = await adminClient
        .from("admin_audit_logs")
        .select(
          `
          *,
          admin:admin_user_id (id, name, email)
        `,
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) throw error;

      return ApiResponse.success(res, "Audit logs retrieved successfully", {
        logs: data,
        pagination: {
          total: count,
          page: Number(page),
          limit: Number(limit),
        },
      });
    } catch (error: any) {
      console.error("Failed to fetch audit logs:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch audit logs",
      );
    }
  }

  /**
   * List all platform users with pagination and search
   */
  async listUsers(req: SupabaseRequest, res: Response) {
    try {
      const { search = "", page = 1, limit = 20 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      let query = adminClient.from("users").select("*", { count: "exact" });

      // Apply search filter if provided
      if (search) {
        query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
      }

      const { data, count, error } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) throw error;

      return ApiResponse.success(res, "Users retrieved successfully", {
        users: data || [],
        pagination: {
          total: count || 0,
          page: Number(page),
          limit: Number(limit),
        },
      });
    } catch (error: any) {
      console.error("Failed to list users:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list users",
      );
    }
  }

  /**
   * Get comprehensive user details including their businesses and activity
   */
  async getUserDetails(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminClient = this.getAdminClient(req);

      // 1. Fetch user profile
      const { data: user, error: userError } = await adminClient
        .from("users")
        .select("*")
        .eq("id", id)
        .single();

      if (userError || !user) {
        return ApiResponse.notFound(res, "User not found");
      }

      // 2. Fetch user's businesses
      const { data: memberships } = await adminClient
        .from("memberships")
        .select(
          `
          business:business_id (*),
          role:role_id (name)
        `,
        )
        .eq("user_id", id);

      // 3. Fetch user's stores
      const { data: stores } = await adminClient
        .from("stores")
        .select("*")
        .eq("user_id", id);

      // 4. Fetch admin notes
      const { data: notes } = await adminClient
        .from("admin_notes")
        .select(
          `
          *,
          admin:admin_user_id (name)
        `,
        )
        .eq("target_type", "user")
        .eq("target_id", id)
        .order("created_at", { ascending: false });

      return ApiResponse.success(res, "User details retrieved successfully", {
        user,
        businesses: memberships?.map((m) => m.business) || [],
        stores: stores || [],
        notes: notes || [],
      });
    } catch (error: any) {
      console.error("Failed to get user details:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get user details",
      );
    }
  }

  /**
   * Get detailed information for a specific business
   */
  async getBusinessDetails(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminClient = this.getAdminClient(req);

      // 1. Fetch Business
      const { data: business, error: businessError } = await adminClient
        .from("businesses")
        .select("*")
        .eq("id", id)
        .single();

      if (businessError || !business) {
        return ApiResponse.notFound(res, "Business not found");
      }

      // 2. Fetch Owner Details
      // We assume the owner is a user in the 'users' table
      const { data: owner, error: ownerError } = await adminClient
        .from("users")
        .select("id, email, name")
        .eq("id", business.owner_user_id)
        .single();

      // 3. Fetch Stores with their orders for revenue calculation
      const { data: stores, error: storesError } = await adminClient
        .from("stores")
        .select(
          `
          id, 
          name, 
          is_live,
          appearance, 
          store_orders(total)
        `,
        )
        .eq("business_id", id);

      if (storesError) throw storesError;

      // 4. Fetch Events
      const { data: events } = await adminClient
        .from("events")
        .select(
          "id, event_name, start_date, status, is_physical, is_online, orders(total_amount)",
        )
        .eq("business_id", id)
        .order("start_date", { ascending: false });

      // 5. Fetch Circles (Sessions)
      const { data: circles } = await adminClient
        .from("circles")
        .select(
          "id, title, access_type, visibility, cached_members_count, session_payments(amount, status)",
        )
        .eq("business_id", id);

      // 6. Fetch Publications
      const { data: publications } = await adminClient
        .from("publications")
        .select(
          `
            id, name, slug, description,
            subscriptions(
                subscription_payments(amount, status)
            )
        `,
        )
        .eq("business_id", id);

      // 7. Calculate Stats
      const total_stores = stores?.length || 0;
      let total_revenue = 0;

      // Calculate Store Revenue
      const storesList =
        stores?.map((store: any) => {
          const storeRevenue =
            store.store_orders?.reduce(
              (sum: number, order: any) => sum + (Number(order.total) || 0),
              0,
            ) || 0;
          total_revenue += storeRevenue;

          return {
            id: store.id,
            name: store.name,
            status: store.is_live ? "active" : "inactive",
            logo_url: store.appearance?.logo || null,
          };
        }) || [];

      // Calculate Event Revenue
      const eventsList =
        events?.map((event: any) => {
          const eventRevenue =
            event.orders?.reduce(
              (sum: number, order: any) =>
                sum + (Number(order.total_amount) || 0),
              0,
            ) || 0;
          total_revenue += eventRevenue;

          return {
            id: event.id,
            title: event.event_name,
            start_datetime: event.start_date,
            status: event.status,
            location_type: event.is_physical
              ? "physical"
              : event.is_online
                ? "online"
                : "unknown",
          };
        }) || [];

      // Calculate Circle Revenue
      const circlesList =
        circles?.map((circle: any) => {
          const circleRevenue =
            circle.session_payments?.reduce((sum: number, payment: any) => {
              // Only count successful payments
              if (payment.status === "success") {
                return sum + (Number(payment.amount) || 0);
              }
              return sum;
            }, 0) || 0;
          total_revenue += circleRevenue;

          return {
            id: circle.id,
            title: circle.title,
            access_type: circle.access_type,
            visibility: circle.visibility,
            members_count: circle.cached_members_count || 0,
          };
        }) || [];

      // Calculate Publication Revenue
      publications?.forEach((pub: any) => {
        pub.subscriptions?.forEach((sub: any) => {
          const subRevenue =
            sub.subscription_payments?.reduce((sum: number, payment: any) => {
              // Only count successful payments
              if (payment.status === "success") {
                return sum + (Number(payment.amount) || 0);
              }
              return sum;
            }, 0) || 0;
          total_revenue += subRevenue;
        });
      });

      // Construct Response
      return ApiResponse.success(
        res,
        "Business details retrieved successfully",
        {
          ...business,
          owner: owner
            ? {
                id: owner.id,
                email: owner.email,
                name: owner.name,
              }
            : null,
          stores: storesList,
          events: eventsList,
          circles: circlesList,
          publications: publications || [],
          stats: {
            total_stores,
            total_revenue,
          },
        },
      );
    } catch (error: any) {
      console.error("Failed to get business details:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get business details",
      );
    }
  }

  /**
   * List all platform businesses
   */
  async listBusinesses(req: SupabaseRequest, res: Response) {
    try {
      const { search = "", page = 1, limit = 20, plan } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      let query = adminClient.from("businesses").select(
        `
          *
        `,
        { count: "exact" },
      );

      // Apply search filter if provided
      if (search) {
        query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
      }

      // Apply plan filter if provided
      if (plan && plan !== "all") {
        query = query.eq("subscription_plan", plan);
      }

      const { data, count, error } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) throw error;

      return ApiResponse.success(res, "Businesses retrieved successfully", {
        businesses: data || [],
        pagination: {
          total: count || 0,
          page: Number(page),
          limit: Number(limit),
        },
      });
    } catch (error: any) {
      console.error("Failed to list businesses:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list businesses",
      );
    }
  }

  /**
   * List all platform courses with activity metrics for monitoring.
   * "Published" / "draft" is derived from whether the course has lessons.
   */
  async listCourses(req: SupabaseRequest, res: Response) {
    try {
      const {
        search = "",
        page = 1,
        limit = 20,
        access_type,
        source,
        status,
      } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      let query = adminClient.from("courses").select(
        `
          id,
          title,
          description,
          icon_emoji,
          banner_color,
          level,
          duration_label,
          access_type,
          circle_id,
          business_id,
          created_by,
          created_at,
          updated_at,
          businesses(id, name, slug, status),
          circles(id, title, slug),
          course_modules(count),
          course_lessons(count),
          course_enrollments(count),
          course_certificates(count)
        `,
        { count: "exact" },
      );

      if (search) {
        query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
      }

      if (access_type && access_type !== "all") {
        query = query.eq("access_type", access_type);
      }

      if (source && source !== "all") {
        query =
          source === "standalone"
            ? query.is("circle_id", null)
            : query.not("circle_id", "is", null);
      }

      if (status === "published") {
        query = query.gt("course_lessons(count)", 0);
      } else if (status === "draft") {
        query = query.eq("course_lessons(count)", 0);
      }

      const { data, count, error } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) throw error;

      const courses = (data || []).map((course: any) => {
        const lessonCount = course.course_lessons?.[0]?.count ?? 0;
        return {
          id: course.id,
          title: course.title,
          description: course.description,
          icon_emoji: course.icon_emoji,
          banner_color: course.banner_color,
          level: course.level,
          duration_label: course.duration_label,
          access_type: course.access_type,
          circle_id: course.circle_id,
          business_id: course.business_id,
          created_by: course.created_by,
          created_at: course.created_at,
          updated_at: course.updated_at,
          business: course.businesses ?? null,
          circle: course.circles ?? null,
          module_count: course.course_modules?.[0]?.count ?? 0,
          lesson_count: lessonCount,
          enrolled_count: course.course_enrollments?.[0]?.count ?? 0,
          certificate_count: course.course_certificates?.[0]?.count ?? 0,
          status: lessonCount > 0 ? "published" : "draft",
        };
      });

      return ApiResponse.success(res, "Courses retrieved successfully", {
        courses,
        pagination: {
          total: count || 0,
          page: Number(page),
          limit: Number(limit),
        },
      });
    } catch (error: any) {
      console.error("Failed to list courses:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list courses",
      );
    }
  }

  /**
   * List all settlements (payouts) from Paystack
   */
  async listPayouts(req: SupabaseRequest, res: Response) {
    try {
      const { status, page = 1, limit = 50, from, to, subaccount } = req.query;

      const result = await listPaystackSettlements({
        page: Number(page),
        perPage: Number(limit),
        status:
          status && status !== "all"
            ? (status as "pending" | "success" | "processing" | "failed")
            : undefined,
        subaccount: subaccount as string | undefined,
        from: from as string | undefined,
        to: to as string | undefined,
      });

      return ApiResponse.success(
        res,
        "Settlements retrieved successfully from Paystack",
        {
          settlements: result.settlements,
          pagination: {
            total: result.meta.total,
            page: result.meta.page,
            limit: result.meta.perPage,
            pageCount: result.meta.pageCount,
          },
        },
      );
    } catch (error: any) {
      console.error("Failed to list settlements from Paystack:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list settlements",
      );
    }
  }

  /**
   * List all platform transactions from Paystack
   */
  async listTransactions(req: SupabaseRequest, res: Response) {
    try {
      const { status, page = 1, limit = 20, from, to, subaccount } = req.query;

      const result = await listPaystackTransactions({
        page: Number(page),
        perPage: Number(limit),
        status:
          status && status !== "all"
            ? (status as "failed" | "success" | "abandoned")
            : undefined,
        from: from as string | undefined,
        to: to as string | undefined,
        subaccount: subaccount as string | undefined,
      });

      return ApiResponse.success(
        res,
        "Transactions retrieved successfully from Paystack",
        {
          transactions: result.transactions,
          pagination: {
            total: result.meta.total,
            page: result.meta.page,
            limit: result.meta.perPage,
            pageCount: result.meta.pageCount,
          },
        },
      );
    } catch (error: any) {
      console.error("Failed to list transactions from Paystack:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list transactions",
      );
    }
  }

  /**
   * Get the content moderation queue (flagged items)
   */
  async getModerationQueue(req: SupabaseRequest, res: Response) {
    try {
      const { status = "pending", page = 1, limit = 20 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      let query = adminClient.from("moderation_reports").select(
        `
          *,
          reporter:reporter_id (id, name),
          resolved_by_admin:resolved_by (id, name)
        `,
        { count: "exact" },
      );

      // Filter by status (default to pending for the queue)
      if (status && status !== "all") {
        query = query.eq("status", status);
      }

      const { data, count, error } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        // Fallback or empty if table doesn't exist yet
        console.warn("Moderation queue query failed:", error.message);
        return ApiResponse.success(res, "Moderation queue retrieved", {
          queue: [],
          pagination: { total: 0, page: 1, limit: 20 },
        });
      }

      return ApiResponse.success(
        res,
        "Moderation queue retrieved successfully",
        {
          queue: data || [],
          pagination: {
            total: count || 0,
            page: Number(page),
            limit: Number(limit),
          },
        },
      );
    } catch (error: any) {
      console.error("Failed to fetch moderation queue:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch moderation queue",
      );
    }
  }

  /**
   * Review and moderate specific content flagged in a report
   */
  async reviewContent(req: SupabaseRequest, res: Response) {
    try {
      const { id: reportId } = req.params;
      const { action, admin_notes, targetType, targetId } = req.body;
      // action: 'approve' (dismiss report) | 'reject' (suspend content)

      if (!["approve", "reject"].includes(action)) {
        return ApiResponse.badRequest(res, "Invalid moderation action");
      }

      // 1. Resolve the report
      const { data: report, error: reportError } = await req.supabase
        .from("moderation_reports")
        .update({
          status: "resolved",
          admin_notes,
          resolved_at: new Date().toISOString(),
          resolved_by: req.admin?.id,
        })
        .eq("id", reportId)
        .select()
        .single();

      if (reportError) throw reportError;

      // 2. Update the target content moderation status
      let table = "";
      switch (targetType) {
        case "post":
          table = "posts";
          break;
        case "product":
          table = "products";
          break;
        case "event":
          table = "events";
          break;
        case "store":
          table = "stores";
          break;
        case "publication":
          table = "publications";
          break;
        default:
          return ApiResponse.badRequest(res, "Unsupported target type");
      }

      const moderation_status = action === "approve" ? "approved" : "rejected";

      const { error: contentError } = await req.supabase
        .from(table)
        .update({
          moderation_status,
          moderated_at: new Date().toISOString(),
          moderated_by: req.admin?.id,
        })
        .eq("id", targetId);

      if (contentError) throw contentError;

      // 3. Log the audit action
      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: `content_moderation.${action}`,
          targetType,
          targetId,
          reason: admin_notes,
          afterData: { moderation_status, report_id: reportId },
        });
      }

      return ApiResponse.success(
        res,
        action === "approve"
          ? "Report dismissed"
          : "Content rejected/suspended",
        { status: moderation_status },
      );
    } catch (error: any) {
      console.error("Failed to moderate content:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to moderate content",
      );
    }
  }

  /**
   * Get all system feature flags
   */
  async getFeatureFlags(req: SupabaseRequest, res: Response) {
    try {
      // Assuming a system_config table or similar
      const { data, error } = await req.supabase
        .from("system_config")
        .select("*")
        .eq("config_type", "feature_flag");

      if (error) {
        return ApiResponse.success(res, "Feature flags retrieved", {
          flags: [],
        });
      }

      return ApiResponse.success(res, "Feature flags retrieved successfully", {
        flags: data,
      });
    } catch (error: any) {
      console.error("Failed to fetch feature flags:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch feature flags",
      );
    }
  }

  /**
   * Update a specific system configuration
   */
  async updateConfig(req: SupabaseRequest, res: Response) {
    try {
      const { key, value } = req.body;

      const { data, error } = await req.supabase
        .from("system_config")
        .upsert({ key, value, updated_at: new Date().toISOString() })
        .select()
        .single();

      if (error) throw error;

      // Log the config change
      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "system.config_update",
          targetType: "config",
          targetId: data.id,
          afterData: { key, value },
        });
      }

      return ApiResponse.success(res, "Configuration updated successfully", {
        config: data,
      });
    } catch (error: any) {
      console.error("Failed to update config:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update configuration",
      );
    }
  }

  /**
   * List all platform publications
   */
  async listPublications(req: SupabaseRequest, res: Response) {
    try {
      const { search = "", page = 1, limit = 20 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      let query = adminClient.from("publications").select(
        `
          *,
          owner:user_id (id, name, email),
          business:business_id (id, name)
        `,
        { count: "exact" },
      );

      // Apply search filter if provided
      if (search) {
        query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
      }

      const { data, count, error } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) throw error;

      return ApiResponse.success(res, "Publications retrieved successfully", {
        publications: data || [],
        pagination: {
          total: count || 0,
          page: Number(page),
          limit: Number(limit),
        },
      });
    } catch (error: any) {
      console.error("Failed to list publications:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list publications",
      );
    }
  }

  /**
   * Send a formal warning to a user regarding content or behavior
   */
  async warnUser(req: SupabaseRequest, res: Response) {
    try {
      const { userId, reason, severity = "medium" } = req.body;

      if (!userId || !reason) {
        return ApiResponse.badRequest(res, "User ID and reason are required");
      }

      // Log the warning in admin_audit_logs
      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "user.warning_issued",
          targetType: "user",
          targetId: userId,
          reason,
          afterData: { severity },
        });
      }

      return ApiResponse.success(res, "Warning issued successfully", {
        notification_status: "queued",
      });
    } catch (error: any) {
      console.error("Failed to issue user warning:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to issue warning",
      );
    }
  }

  /**
   * List all admin users (Super Admin only)
   */
  async listAdmins(req: SupabaseRequest, res: Response) {
    try {
      const { data, error } = await req.supabase
        .from("admin_users")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      return ApiResponse.success(res, "Admin users retrieved successfully", {
        admins: data,
      });
    } catch (error: any) {
      console.error("Failed to list admins:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list admins",
      );
    }
  }

  /**
   * Create or update an admin user
   */
  async saveAdmin(req: SupabaseRequest, res: Response) {
    try {
      const { user_id, role, name, email, permissions, is_active } = req.body;

      const { data, error } = await req.supabase
        .from("admin_users")
        .upsert({
          user_id,
          role,
          name,
          email,
          permissions,
          is_active,
          created_by: req.admin?.id,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      return ApiResponse.success(res, "Admin user saved successfully", {
        admin: data,
      });
    } catch (error: any) {
      console.error("Failed to save admin:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to save admin user",
      );
    }
  }

  /**
   * Generate an impersonation token or link for a user
   */
  async impersonateUser(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;

      // In Supabase, we can't easily "generate a login link" without a secret
      // But we can return the data needed for the frontend to switch context
      // or use a service-role to sign a custom token if configured.

      const { data: user, error } = await req.supabase
        .from("users")
        .select("*")
        .eq("id", id)
        .single();

      if (error || !user) {
        return ApiResponse.notFound(res, "User not found");
      }

      // Log the impersonation event (Critical for security)
      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "user.impersonate",
          targetType: "user",
          targetId: id,
          reason: "Admin support session started",
        });
      }

      return ApiResponse.success(res, "Impersonation data retrieved", {
        user_id: user.id,
        email: user.email,
        notice:
          "Frontend should use this ID to scope requests via service-role bypass headers if available",
      });
    } catch (error: any) {
      console.error("Impersonation error:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to start impersonation",
      );
    }
  }

  /**
   * Manually upgrade a business subscription to a specified plan
   */
  async upgradeBusinessSubscription(req: SupabaseRequest, res: Response) {
    try {
      const { businessId, plan } = req.body;

      if (!businessId) {
        return ApiResponse.badRequest(res, "Business ID is required");
      }

      if (!plan || !["starter", "plus", "pro"].includes(plan)) {
        return ApiResponse.badRequest(
          res,
          "Valid plan is required (starter, plus, or pro)",
        );
      }

      const adminService = new AdminService(this.getAdminClient(req));

      const result = await adminService.upgradeBusinessSubscription(
        businessId,
        plan,
        req.admin?.id || "system",
      );

      if (!result.success) {
        if (result.error === "NOT_FOUND") {
          return ApiResponse.notFound(res, result.message);
        }
        return ApiResponse.serverError(res, result.message);
      }

      return ApiResponse.success(res, result.message, {
        business: result.business,
      });
    } catch (error: any) {
      console.error("Failed to upgrade business subscription:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to upgrade business subscription",
      );
    }
  }

  // ============================================
  // STORE MANAGEMENT
  // ============================================

  /**
   * Helper to calculate store stats (revenue) robustly, handling > 1000 orders
   */
  private async calculateStoreRevenue(
    adminClient: any,
    storeId: string,
    knownTotalOrders?: number,
  ): Promise<number> {
    let totalOrders: number;

    if (knownTotalOrders !== undefined) {
      totalOrders = knownTotalOrders;
    } else {
      const { count } = await adminClient
        .from("store_orders")
        .select("*", { count: "exact", head: true })
        .eq("store_id", storeId);
      totalOrders = count || 0;
    }

    let totalRevenue = 0;
    const BATCH_SIZE = 1000;

    // If small enough, just one fetch (or re-fetch if we didn't have data passed in)
    // Note: In listStores we might have partial data, but easiest is to just fetch clean if > limit
    // Optimization: If we are calling this, we assume we need to fetch.

    if (totalOrders <= BATCH_SIZE) {
      const { data } = await adminClient
        .from("store_orders")
        .select("total, status")
        .eq("store_id", storeId);

      (data || []).forEach((order: any) => {
        if (["paid", "processing", "fulfilled"].includes(order.status)) {
          totalRevenue += Number(order.total) || 0;
        }
      });
    } else {
      // Batch fetch
      let hasMore = true;
      let page = 0;

      while (hasMore) {
        const { data, error } = await adminClient
          .from("store_orders")
          .select("total, status")
          .eq("store_id", storeId)
          .range(page * BATCH_SIZE, (page + 1) * BATCH_SIZE - 1);

        if (error || !data || data.length === 0) {
          hasMore = false;
        } else {
          data.forEach((order: any) => {
            if (["paid", "processing", "fulfilled"].includes(order.status)) {
              totalRevenue += Number(order.total) || 0;
            }
          });

          if (data.length < BATCH_SIZE) hasMore = false;
          else page++;
        }

        if (page > 100) hasMore = false; // Safety cap
      }
    }

    return totalRevenue;
  }

  /**
   * List all stores with statistics (product count, order count, revenue)
   */
  /**
   * Filter a stores query by the derived status. A store is "suspended" when
   * moderation has rejected it, "active" when it is live, otherwise "inactive"
   * — so the non-suspended cases keep moderation_status null-or-not-rejected.
   */
  private applyStoreStatusFilter(query: any, status: string) {
    const notRejected =
      "moderation_status.is.null,moderation_status.neq.rejected";
    switch (status) {
      case "active":
        return query.eq("is_live", true).or(notRejected);
      case "inactive":
        return query.or("is_live.is.null,is_live.eq.false").or(notRejected);
      case "suspended":
        return query.eq("moderation_status", "rejected");
      default:
        return query;
    }
  }

  async listStores(req: SupabaseRequest, res: Response) {
    try {
      const { search = "", status = "all", page = 1, limit = 20 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const adminClient = this.getAdminClient(req);

      // 1. Fetch Stores with search and pagination
      // Added `orders_count:store_orders(count)` to get exact count
      let query = adminClient.from("stores").select(
        `
          *,
          business:business_id (id, name),
          products:products(count),
          store_orders(total, status),
          orders_count:store_orders(count)
        `,
        { count: "exact" },
      );

      // Apply search filter if provided
      if (search) {
        query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
      }

      // Status is derived from moderation_status/is_live, so filter on those
      // columns here to keep the paginated count accurate.
      query = this.applyStoreStatusFilter(query, String(status));

      const { data, count, error } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) throw error;

      // 2. Process data to calculate statistics
      // Use Promise.all to handle potential async revenue calculation for large stores
      const stores = await Promise.all(
        (data || []).map(async (store: any) => {
          // Get Exact Total Orders
          // Supabase returns count as [{ count: N }] or just N depending on versions/client
          // Based on previous code `products` handling: store.products?.[0]?.count
          const totalOrders =
            store.orders_count?.[0]?.count ??
            store.orders_count?.count ??
            store.store_orders?.length ??
            0;

          let revenue = 0;

          // Optimize: If orders <= 1000, use the joined data
          // Check if joined data length matches total count (meaning we have everything)
          // store.store_orders is the array from the join
          const fetchedOrdersCount = store.store_orders?.length || 0;

          if (fetchedOrdersCount >= totalOrders) {
            // We have all orders in memory
            const validOrders =
              store.store_orders?.filter((o: any) =>
                ["paid", "processing", "fulfilled"].includes(o.status),
              ) || [];

            revenue = validOrders.reduce(
              (sum: number, order: any) => sum + (Number(order.total) || 0),
              0,
            );
          } else {
            // We have truncated data, need to fetch full revenue
            // This happens if totalOrders > 1000 (Supabase limit)
            revenue = await this.calculateStoreRevenue(
              adminClient,
              store.id,
              totalOrders,
            );
          }

          // Count products
          const productCount =
            store.products?.[0]?.count ?? store.products?.count ?? 0;

          const status =
            store.moderation_status === "rejected"
              ? "suspended"
              : store.is_live
                ? "active"
                : "inactive";

          return {
            id: store.id,
            name: store.name,
            business_id: store.business_id,
            business_name: store.business?.name,
            slug: store.slug,
            status,
            is_live: store.is_live,
            created_at: store.created_at,
            product_count: productCount,
            total_orders: totalOrders,
            revenue: revenue,
          };
        }),
      );

      return ApiResponse.success(res, "Stores retrieved successfully", {
        stores,
        pagination: {
          total: count || 0,
          page: Number(page),
          limit: Number(limit),
        },
      });
    } catch (error: any) {
      console.error("Failed to list stores:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list stores",
      );
    }
  }

  /**
   * Get single store details with stats and recent orders
   */
  async getStoreDetails(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminClient = this.getAdminClient(req);

      console.log(`[Admin] Fetching details for Store ID: ${id}`);

      if (!id || id === "undefined") {
        return ApiResponse.badRequest(res, "Invalid Store ID");
      }

      // 1. Fetch Store basic data first to verify existence (and debug RLS/Relation issues)
      const { data: storeBasic, error: basicError } = await adminClient
        .from("stores")
        .select("*")
        .eq("id", id)
        .single();

      if (basicError || !storeBasic) {
        console.error(
          `[Admin] Store lookup failed for ID ${id}:`,
          basicError?.message,
        );
        return ApiResponse.notFound(
          res,
          "Store not found (Basic Check Failed)",
        );
      }

      // 2. Fetch Associations separate or with safe joins
      const { data: businessData, error: businessError } = await adminClient
        .from("businesses")
        .select("id, name, support_email, support_phone")
        .eq("id", storeBasic.business_id)
        .single();

      if (businessError) {
        console.error(
          `[Admin] Failed to fetch business for store ${id}:`,
          businessError,
        );
      }

      const { data: ownerData, error: ownerError } = await adminClient
        .from("users")
        .select("email")
        .eq("id", storeBasic.user_id)
        .single();

      if (ownerError) {
        console.error(
          `[Admin] Failed to fetch owner for store ${id}:`,
          ownerError,
        );
      }

      const store = {
        ...storeBasic,
        business: businessData,
        owner: ownerData,
      };

      // 2. Fetch Aggregated Stats concurrently
      //   - Active Products count
      //   - All Products count
      const { count: totalProducts } = await adminClient
        .from("products")
        .select("*", { count: "exact", head: true })
        .eq("store_id", id);

      const { count: activeProducts } = await adminClient
        .from("products")
        .select("*", { count: "exact", head: true })
        .eq("store_id", id)
        .eq("status", "published");

      // 3. Fetch Orders for revenue calculation and counts

      // Get exact count first (bypassing the 1000 row limit for the counter)
      const { count: realTotalOrders, error: countError } = await adminClient
        .from("store_orders")
        .select("*", { count: "exact", head: true })
        .eq("store_id", id);

      if (countError) {
        console.error(
          `[Admin] Failed to count orders for store ${id}:`,
          countError,
        );
      }

      const totalOrders = realTotalOrders || 0;

      // Calculate Revenue using helper
      const totalRevenue = await this.calculateStoreRevenue(
        adminClient,
        id,
        totalOrders,
      );

      // 4. Fetch Recent Orders (limit 5)

      const { data: recentOrders, error: recentOrdersError } = await adminClient
        .from("store_orders")
        .select("*")
        .eq("store_id", id)
        .order("created_at", { ascending: false })
        .limit(5);

      if (recentOrdersError) {
        console.error(
          `[Admin] Failed to fetch recent orders for store ${id}:`,
          recentOrdersError,
        );
      }

      // Map orders to ensure frontend compatibility (aliases)
      const mappedOrders = (recentOrders || []).map((order: any) => ({
        ...order,
        amount: order.total,
        date: order.created_at,
        customer: {
          name: order.customer_name,
          email: order.customer_email,
          phone: order.customer_phone,
        },
      }));

      // Construct Response
      const businessEmail =
        store.business?.support_email || store.owner?.email || "N/A";
      const businessPhone = store.business?.support_phone || null;

      const responseData = {
        id: store.id,
        business_id: store.business_id,
        name: store.name,
        slug: store.slug,
        description: store.appearance?.description || "",
        status:
          store.moderation_status === "rejected"
            ? "suspended"
            : store.is_live
              ? "active"
              : "inactive",
        currency: "NGN", // Default as per schema/project usually, or fetch from store settings if available
        created_at: store.created_at,
        logo_url: store.appearance?.logo || null,
        delivery_locations: [], // Not strictly in schema, returning empty array as requested placeholder
        business: {
          id: store.business?.id,
          name: store.business?.name,
          email: businessEmail,
          phone: businessPhone,
        },
        stats: {
          total_products: totalProducts || 0,
          active_products: activeProducts || 0,
          total_orders: totalOrders,
          total_revenue: totalRevenue,
        },
        recent_orders: mappedOrders,
      };

      return ApiResponse.success(
        res,
        "Store details retrieved successfully",
        responseData,
      );
    } catch (error: any) {
      console.error("Failed to get store details:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get store details",
      );
    }
  }

  // ============================================
  // BUSINESS CATEGORY MANAGEMENT
  // ============================================

  /**
   * List all business categories with optional filters
   */
  async listCategories(req: SupabaseRequest, res: Response) {
    try {
      const {
        search = "",
        includeInactive = "false",
        parentOnly = "false",
      } = req.query;
      console.log(
        `[Admin] listCategories called with search='${search}', includeInactive='${includeInactive}'`,
      );
      const adminClient = this.getAdminClient(req);

      let query = adminClient
        .from("business_categories")
        .select("*", { count: "exact" })
        .order("label", { ascending: true });

      // Filter by active status
      if (includeInactive !== "true") {
        query = query.eq("is_active", true);
      }

      // Filter to parent categories only
      if (parentOnly === "true") {
        query = query.is("parent_id", null);
      }

      // Apply search filter
      if (search) {
        query = query.or(`label.ilike.%${search}%,slug.ilike.%${search}%`);
      }

      const { data, count, error } = await query;

      if (error) throw error;

      // Build hierarchical tree structure
      const categories = data || [];
      const categoryMap = new Map<string, any>();
      const rootCategories: any[] = [];

      // First pass: create map
      categories.forEach((cat: any) => {
        categoryMap.set(cat.id, { ...cat, subcategories: [] });
      });

      // Second pass: build tree
      categories.forEach((cat: any) => {
        const category = categoryMap.get(cat.id)!;
        if (cat.parent_id) {
          const parent = categoryMap.get(cat.parent_id);
          if (parent) {
            parent.subcategories.push(category);
          }
        } else {
          rootCategories.push(category);
        }
      });

      return ApiResponse.success(res, "Categories retrieved successfully", {
        categories: rootCategories,
        flatList: categories,
        total: count || 0,
      });
    } catch (error: any) {
      console.error("Failed to list categories:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list categories",
      );
    }
  }

  /**
   * Get a single category with its subcategories
   */
  async getCategory(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminClient = this.getAdminClient(req);

      const { data: category, error } = await adminClient
        .from("business_categories")
        .select("*")
        .eq("id", id)
        .single();

      if (error || !category) {
        return ApiResponse.notFound(res, "Category not found");
      }

      // Get subcategories if it's a parent
      const { data: subcategories } = await adminClient
        .from("business_categories")
        .select("*")
        .eq("parent_id", id)
        .order("label", { ascending: true });

      // Get parent if it's a subcategory
      let parent = null;
      if (category.parent_id) {
        const { data: parentData } = await adminClient
          .from("business_categories")
          .select("id, slug, label")
          .eq("id", category.parent_id)
          .single();
        parent = parentData;
      }

      // Get usage count
      const { count: usageCount } = await adminClient
        .from("businesses")
        .select("id", { count: "exact", head: true })
        .or(
          `category_slug.eq.${category.slug},sub_category_slug.eq.${category.slug}`,
        );

      return ApiResponse.success(res, "Category retrieved successfully", {
        category: {
          ...category,
          subcategories: subcategories || [],
          parent,
          usage_count: usageCount || 0,
        },
      });
    } catch (error: any) {
      console.error("Failed to get category:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get category",
      );
    }
  }

  /**
   * Create a new category or subcategory
   */
  async createCategory(req: SupabaseRequest, res: Response) {
    try {
      const { label, slug, parent_id, icon, description, display_order } =
        req.body;

      if (!label || !slug) {
        return ApiResponse.badRequest(res, "Label and slug are required");
      }

      if (!/^[a-z0-9_]+$/.test(slug)) {
        return ApiResponse.badRequest(
          res,
          "Slug must be lowercase alphanumeric with underscores only",
        );
      }

      const adminClient = this.getAdminClient(req);

      // Check for duplicate slug
      const { data: existing } = await adminClient
        .from("business_categories")
        .select("id")
        .eq("slug", slug)
        .single();

      if (existing) {
        return ApiResponse.badRequest(
          res,
          "A category with this slug already exists",
        );
      }

      // Verify parent if provided
      if (parent_id) {
        const { data: parent, error: parentError } = await adminClient
          .from("business_categories")
          .select("id, parent_id")
          .eq("id", parent_id)
          .single();

        if (parentError || !parent) {
          return ApiResponse.badRequest(res, "Parent category not found");
        }

        if (parent.parent_id) {
          return ApiResponse.badRequest(
            res,
            "Cannot create subcategory of a subcategory (max 2 levels)",
          );
        }
      }

      const { data: category, error } = await adminClient
        .from("business_categories")
        .insert([
          {
            label,
            slug,
            parent_id: parent_id || null,
            icon: icon || null,
            description: description || null,

            is_active: true,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "category.create",
          targetType: "business_category",
          targetId: category.id,
          afterData: { label, slug, parent_id },
        });
      }

      return ApiResponse.success(res, "Category created successfully", {
        category,
      });
    } catch (error: any) {
      console.error("Failed to create category:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to create category",
      );
    }
  }

  /**
   * Update an existing category
   */
  async updateCategory(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const { label, slug, icon, description, display_order, is_active } =
        req.body;
      const adminClient = this.getAdminClient(req);

      const { data: existing, error: fetchError } = await adminClient
        .from("business_categories")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !existing) {
        return ApiResponse.notFound(res, "Category not found");
      }

      // Validate new slug if changing
      if (slug && slug !== existing.slug) {
        if (!/^[a-z0-9_]+$/.test(slug)) {
          return ApiResponse.badRequest(
            res,
            "Slug must be lowercase alphanumeric with underscores only",
          );
        }

        const { data: duplicate } = await adminClient
          .from("business_categories")
          .select("id")
          .eq("slug", slug)
          .neq("id", id)
          .single();

        if (duplicate) {
          return ApiResponse.badRequest(
            res,
            "A category with this slug already exists",
          );
        }
      }

      const updateData: any = {};
      if (label !== undefined) updateData.label = label;
      if (slug !== undefined) updateData.slug = slug;
      if (icon !== undefined) updateData.icon = icon;
      if (description !== undefined) updateData.description = description;

      if (is_active !== undefined) updateData.is_active = is_active;

      const { data: category, error } = await adminClient
        .from("business_categories")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      // Update business references if slug changed
      if (slug && slug !== existing.slug) {
        await adminClient
          .from("businesses")
          .update({ category_slug: slug })
          .eq("category_slug", existing.slug);

        await adminClient
          .from("businesses")
          .update({ sub_category_slug: slug })
          .eq("sub_category_slug", existing.slug);
      }

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "category.update",
          targetType: "business_category",
          targetId: id,
          beforeData: existing,
          afterData: category,
        });
      }

      return ApiResponse.success(res, "Category updated successfully", {
        category,
      });
    } catch (error: any) {
      console.error("Failed to update category:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update category",
      );
    }
  }

  /**
   * Delete (soft) a category
   */
  async deleteCategory(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const { hardDelete = false } = req.body;
      const adminClient = this.getAdminClient(req);

      const { data: category, error: fetchError } = await adminClient
        .from("business_categories")
        .select("*, subcategories:business_categories!parent_id(id)")
        .eq("id", id)
        .single();

      if (fetchError || !category) {
        return ApiResponse.notFound(res, "Category not found");
      }

      if (category.subcategories && category.subcategories.length > 0) {
        return ApiResponse.badRequest(
          res,
          "Cannot delete category with subcategories. Delete subcategories first.",
        );
      }

      const { count: usageCount } = await adminClient
        .from("businesses")
        .select("id", { count: "exact", head: true })
        .or(
          `category_slug.eq.${category.slug},sub_category_slug.eq.${category.slug}`,
        );

      if (usageCount && usageCount > 0 && hardDelete) {
        return ApiResponse.badRequest(
          res,
          `Cannot hard delete: ${usageCount} businesses are using this category. Deactivate instead.`,
        );
      }

      if (hardDelete && req.admin?.role === "super_admin") {
        const { error } = await adminClient
          .from("business_categories")
          .delete()
          .eq("id", id);
        if (error) throw error;
      } else {
        const { error } = await adminClient
          .from("business_categories")
          .update({ is_active: false })
          .eq("id", id);
        if (error) throw error;
      }

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: hardDelete ? "category.hard_delete" : "category.deactivate",
          targetType: "business_category",
          targetId: id,
          beforeData: category,
        });
      }

      return ApiResponse.success(
        res,
        hardDelete
          ? "Category deleted permanently"
          : "Category deactivated successfully",
      );
    } catch (error: any) {
      console.error("Failed to delete category:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to delete category",
      );
    }
  }

  /**
   * Reorder categories (bulk update display_order)
   */
  async reorderCategories(req: SupabaseRequest, res: Response) {
    try {
      const { orderedIds } = req.body;

      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return ApiResponse.badRequest(res, "orderedIds array is required");
      }

      const adminClient = this.getAdminClient(req);

      /*
      // Schema update needed: display_order column missing
      const updates = orderedIds.map((id: string, index: number) =>
        adminClient
          .from("business_categories")
          .update({ display_order: index + 1 })
          .eq("id", id),
      );

      await Promise.all(updates);
      */
      console.warn(
        "[Admin] reorderCategories skipped: 'display_order' column missing in schema",
      );

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "category.reorder",
          targetType: "business_category",
          afterData: { orderedIds },
        });
      }

      return ApiResponse.success(res, "Categories reordered successfully");
    } catch (error: any) {
      console.error("Failed to reorder categories:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to reorder categories",
      );
    }
  }

  /**
   * Get category usage statistics
   */
  async getCategoryStats(req: SupabaseRequest, res: Response) {
    try {
      const adminClient = this.getAdminClient(req);

      const { data: categories, error } = await adminClient
        .from("business_categories")
        .select("id, slug, label, parent_id, is_active")
        .order("label");

      if (error) throw error;

      const { data: categoryUsage } = await adminClient
        .from("businesses")
        .select("category_slug, sub_category_slug");

      const usageMap = new Map<string, number>();
      categoryUsage?.forEach((b: any) => {
        if (b.category_slug) {
          usageMap.set(
            b.category_slug,
            (usageMap.get(b.category_slug) || 0) + 1,
          );
        }
        if (b.sub_category_slug) {
          usageMap.set(
            b.sub_category_slug,
            (usageMap.get(b.sub_category_slug) || 0) + 1,
          );
        }
      });

      const stats =
        categories?.map((cat: any) => ({
          id: cat.id,
          slug: cat.slug,
          label: cat.label,
          is_parent: !cat.parent_id,
          is_active: cat.is_active,
          business_count: usageMap.get(cat.slug) || 0,
        })) || [];

      const totalCategories = categories?.length || 0;
      const parentCategories =
        categories?.filter((c: any) => !c.parent_id).length || 0;
      const activeCategories =
        categories?.filter((c: any) => c.is_active).length || 0;
      const unusedCategories = stats.filter(
        (s: any) => s.business_count === 0,
      ).length;

      return ApiResponse.success(
        res,
        "Category statistics retrieved successfully",
        {
          stats,
          summary: {
            total_categories: totalCategories,
            parent_categories: parentCategories,
            subcategories: totalCategories - parentCategories,
            active_categories: activeCategories,
            inactive_categories: totalCategories - activeCategories,
            unused_categories: unusedCategories,
            total_businesses_categorized: categoryUsage?.length || 0,
          },
        },
      );
    } catch (error: any) {
      console.error("Failed to get category stats:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get category statistics",
      );
    }
  }

  /**
   * GET /api/admin/plans
   * List all subscription plans
   */
  async listPlans(req: SupabaseRequest, res: Response) {
    try {
      const service = new AdminService(this.getAdminClient(req));
      const plans = await service.listPlans();
      return ApiResponse.success(
        res,
        "Subscription plans retrieved successfully",
        plans,
      );
    } catch (error: any) {
      console.error("Failed to list plans:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list plans",
      );
    }
  }

  /**
   * GET /api/admin/plans/:id
   * Get single plan details
   */
  async getPlan(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const service = new AdminService(this.getAdminClient(req));
      const plan = await service.getPlan(id);
      return ApiResponse.success(
        res,
        "Plan details retrieved successfully",
        plan,
      );
    } catch (error: any) {
      console.error("Failed to get plan:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get plan details",
      );
    }
  }

  /**
   * POST /api/admin/plans
   * PUT /api/admin/plans/:id
   * Create or update a plan
   */
  async savePlan(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const updates = req.body;
      const adminUserId = (req as any).adminUser?.id;

      const service = new AdminService(this.getAdminClient(req));
      let result;

      if (id) {
        result = await service.updatePlan(id, updates, adminUserId);
      } else {
        result = await service.createPlan(updates, adminUserId);
      }

      // Automatically clear cache when a plan is updated
      const { planLimitsService } =
        await import("../services/plan-limits.service");
      planLimitsService.clearCache();

      return ApiResponse.success(
        res,
        id ? "Plan updated successfully" : "Plan created successfully",
        result,
      );
    } catch (error: any) {
      console.error("Failed to save plan:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to save plan",
      );
    }
  }

  /**
   * DELETE /api/admin/plans/:id
   */
  async deletePlan(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminUserId = (req as any).adminUser?.id;
      const service = new AdminService(this.getAdminClient(req));

      await service.deletePlan(id, adminUserId);

      return ApiResponse.success(res, "Plan deleted successfully", null);
    } catch (error: any) {
      console.error("Failed to delete plan:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to delete plan",
      );
    }
  }

  /**
   * GET /api/admin/plans/stats
   */
  async getPlanStats(req: SupabaseRequest, res: Response) {
    try {
      const service = new AdminService(this.getAdminClient(req));
      const stats = await service.getPlanStats();
      return ApiResponse.success(
        res,
        "Plan statistics retrieved successfully",
        stats,
      );
    } catch (error: any) {
      console.error("Failed to get plan stats:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get plan statistics",
      );
    }
  }

  /**
   * POST /api/admin/plans/cache/clear
   */
  async clearPlanCache(req: SupabaseRequest, res: Response) {
    try {
      const { planLimitsService } =
        await import("../services/plan-limits.service");
      planLimitsService.clearCache();
      return ApiResponse.success(res, "Plan cache cleared successfully", null);
    } catch (error: any) {
      console.error("Failed to clear plan cache:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to clear plan cache",
      );
    }
  }

  // ============================================================
  // PHASE 1: Analytics — MRR / ARR / Churn
  // ============================================================

  /**
   * GET /api/admin/analytics/overview
   */
  async getAnalyticsOverview(req: SupabaseRequest, res: Response) {
    try {
      const { mrrService } = await import("../services/mrr.service");
      const analytics = await mrrService.getFullAnalytics(req.supabase);
      return ApiResponse.success(
        res,
        "Analytics overview retrieved successfully",
        analytics,
      );
    } catch (error: any) {
      console.error("Failed to get analytics overview:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get analytics overview",
      );
    }
  }

  // ============================================================
  // PHASE 1: Admin Finance — P&L Dashboard
  // ============================================================

  /**
   * GET /api/admin/finance/overview
   */
  async getFinanceOverview(req: SupabaseRequest, res: Response) {
    try {
      const { adminFinanceService } =
        await import("../services/admin-finance.service");
      const [summary, pnl, subscriptions] = await Promise.all([
        adminFinanceService.getPlatformRevenueSummary(req.supabase),
        adminFinanceService.getPlatformPnL(req.supabase),
        adminFinanceService.getSubscriptionRevenueSummary(req.supabase),
      ]);
      return ApiResponse.success(
        res,
        "Finance overview retrieved successfully",
        { summary, pnl, subscriptions },
      );
    } catch (error: any) {
      console.error("Failed to get finance overview:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get finance overview",
      );
    }
  }

  /**
   * GET /api/admin/finance/timeseries?months=6
   */
  async getFinanceTimeSeries(req: SupabaseRequest, res: Response) {
    try {
      const months = Math.min(parseInt(req.query.months as string) || 6, 24);
      const { adminFinanceService } =
        await import("../services/admin-finance.service");
      const data = await adminFinanceService.getRevenueByMonth(
        req.supabase,
        months,
      );
      return ApiResponse.success(
        res,
        "Finance time series retrieved successfully",
        data,
      );
    } catch (error: any) {
      console.error("Failed to get finance time series:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get finance time series",
      );
    }
  }

  /**
   * GET /api/admin/finance/top-businesses?limit=10
   */
  async getTopRevenueBusinesses(req: SupabaseRequest, res: Response) {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const { adminFinanceService } =
        await import("../services/admin-finance.service");
      const data = await adminFinanceService.getTopRevenueBusinesses(
        req.supabase,
        limit,
      );
      return ApiResponse.success(
        res,
        "Top revenue businesses retrieved successfully",
        data,
      );
    } catch (error: any) {
      console.error("Failed to get top revenue businesses:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get top revenue businesses",
      );
    }
  }

  // ============================================================
  // PHASE 1: Dunning Management
  // ============================================================

  /**
   * GET /api/admin/dunning?status=active&page=1&limit=20
   */
  async getDunningCases(req: SupabaseRequest, res: Response) {
    try {
      const { dunningService } = await import("../services/dunning.service");
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as any;
      const result = status
        ? await dunningService.getDunningHistory(
            req.supabase,
            page,
            limit,
            status,
          )
        : await dunningService.getActiveDunningCases(req.supabase, page, limit);
      return ApiResponse.success(
        res,
        "Dunning cases retrieved successfully",
        result,
      );
    } catch (error: any) {
      console.error("Failed to get dunning cases:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get dunning cases",
      );
    }
  }

  /**
   * POST /api/admin/dunning/process-retries
   */
  async processDunningRetries(req: SupabaseRequest, res: Response) {
    try {
      const { dunningService } = await import("../services/dunning.service");
      const result = await dunningService.processRetries(req.supabase);
      return ApiResponse.success(
        res,
        `Processed ${result.processed} dunning cases, cancelled ${result.cancelled}`,
        result,
      );
    } catch (error: any) {
      console.error("Failed to process dunning retries:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to process dunning retries",
      );
    }
  }

  // ============================================================
  // PHASE 1: Upgrade Signals
  // ============================================================

  /**
   * GET /api/admin/upgrade-signals
   */
  async getUpgradeSignals(req: SupabaseRequest, res: Response) {
    try {
      const { upgradeSignalsService } =
        await import("../services/upgrade-signals.service");
      const { plan, resource, page, limit, unresolved_only } = req.query;
      const result = await upgradeSignalsService.getUpgradeSignals(
        req.supabase,
        {
          plan: plan as string,
          resource: resource as string,
          page: parseInt(page as string) || 1,
          limit: parseInt(limit as string) || 20,
          unresolved_only: unresolved_only !== "false",
        },
      );
      return ApiResponse.success(
        res,
        "Upgrade signals retrieved successfully",
        result,
      );
    } catch (error: any) {
      console.error("Failed to get upgrade signals:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get upgrade signals",
      );
    }
  }

  /**
   * GET /api/admin/upgrade-signals/summary
   */
  async getUpgradeSignalsSummary(req: SupabaseRequest, res: Response) {
    try {
      const { upgradeSignalsService } =
        await import("../services/upgrade-signals.service");
      const summary = await upgradeSignalsService.getUpgradeSignalsSummary(
        req.supabase,
      );
      return ApiResponse.success(
        res,
        "Upgrade signals summary retrieved successfully",
        summary,
      );
    } catch (error: any) {
      console.error("Failed to get upgrade signals summary:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get upgrade signals summary",
      );
    }
  }

  // ============================================================
  // PHASE 2: Admin User Management — update role, deactivate
  // ============================================================

  /**
   * PATCH /api/admin/admins/:id — Update role or active status
   */
  async updateAdmin(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const { role, is_active, permissions } = req.body;
      const adminClient = this.getAdminClient(req);

      const updates: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };
      if (role !== undefined) updates.role = role;
      if (is_active !== undefined) updates.is_active = is_active;
      if (permissions !== undefined) updates.permissions = permissions;

      const { data, error } = await adminClient
        .from("admin_users")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      const adminService = new AdminService(req.supabase);
      if (req.admin) {
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: "admin.update",
          targetType: "admin_user",
          targetId: id,
          afterData: updates,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return ApiResponse.success(res, "Admin user updated successfully", {
        admin: data,
      });
    } catch (error: any) {
      console.error("Failed to update admin:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update admin",
      );
    }
  }

  /**
   * DELETE /api/admin/admins/:id — Deactivate admin (soft delete)
   */
  async deactivateAdmin(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const adminClient = this.getAdminClient(req);

      // Prevent self-deactivation
      if (req.admin?.id === id) {
        return ApiResponse.error(
          res,
          "Cannot deactivate your own account",
          400,
        );
      }

      await adminClient
        .from("admin_users")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", id);

      return ApiResponse.success(res, "Admin user deactivated", null);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to deactivate admin",
      );
    }
  }

  // ============================================================
  // PHASE 2: Bulk Operations
  // ============================================================

  /**
   * POST /api/admin/bulk/users — Bulk user actions
   * Body: { action: "suspend"|"activate"|"warn", userIds: string[], reason?: string }
   */
  async bulkUserAction(req: SupabaseRequest, res: Response) {
    try {
      const { action, userIds, reason } = req.body;
      if (!action || !userIds?.length) {
        return ApiResponse.error(res, "action and userIds are required", 400);
      }

      const adminClient = this.getAdminClient(req);
      let updated = 0;

      if (action === "suspend") {
        const { count } = await adminClient
          .from("users")
          .update({ status: "suspended", updated_at: new Date().toISOString() })
          .in("id", userIds);
        updated = count || userIds.length;
      } else if (action === "activate") {
        const { count } = await adminClient
          .from("users")
          .update({ status: "active", updated_at: new Date().toISOString() })
          .in("id", userIds);
        updated = count || userIds.length;
      } else if (action === "warn") {
        // Insert warnings for each user
        const warnings = userIds.map((uid: string) => ({
          user_id: uid,
          reason: reason || "Policy violation",
          severity: "warning",
          created_by: req.admin?.id,
        }));
        await adminClient.from("user_warnings").insert(warnings);
        updated = userIds.length;
      } else {
        return ApiResponse.error(res, `Unknown action: ${action}`, 400);
      }

      const adminService = new AdminService(req.supabase);
      if (req.admin) {
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: `bulk.users.${action}`,
          targetType: "user",
          afterData: { userIds, reason, count: updated },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return ApiResponse.success(
        res,
        `Bulk ${action} applied to ${updated} users`,
        { updated },
      );
    } catch (error: any) {
      console.error("Bulk user action failed:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Bulk action failed",
      );
    }
  }

  /**
   * POST /api/admin/bulk/businesses — Bulk business actions
   * Body: { action: "upgrade"|"downgrade"|"suspend", businessIds: string[], plan?: string }
   */
  async bulkBusinessAction(req: SupabaseRequest, res: Response) {
    try {
      const { action, businessIds, plan } = req.body;
      if (!action || !businessIds?.length) {
        return ApiResponse.error(
          res,
          "action and businessIds are required",
          400,
        );
      }

      const adminClient = this.getAdminClient(req);
      let updated = 0;

      if (action === "upgrade" || action === "downgrade") {
        if (!plan)
          return ApiResponse.error(
            res,
            "plan is required for upgrade/downgrade",
            400,
          );
        const { count } = await adminClient
          .from("businesses")
          .update({
            subscription_plan: plan,
            updated_at: new Date().toISOString(),
          })
          .in("id", businessIds);
        updated = count || businessIds.length;
      } else if (action === "suspend") {
        const { count } = await adminClient
          .from("businesses")
          .update({ status: "suspended", updated_at: new Date().toISOString() })
          .in("id", businessIds);
        updated = count || businessIds.length;
      } else if (action === "activate") {
        const { count } = await adminClient
          .from("businesses")
          .update({ status: "active", updated_at: new Date().toISOString() })
          .in("id", businessIds);
        updated = count || businessIds.length;
      } else {
        return ApiResponse.error(res, `Unknown action: ${action}`, 400);
      }

      const adminService = new AdminService(req.supabase);
      if (req.admin) {
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: `bulk.businesses.${action}`,
          targetType: "business",
          afterData: { businessIds, plan, count: updated },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return ApiResponse.success(
        res,
        `Bulk ${action} applied to ${updated} businesses`,
        { updated },
      );
    } catch (error: any) {
      console.error("Bulk business action failed:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Bulk action failed",
      );
    }
  }

  // ============================================================
  // PHASE 2: Admin Alerts
  // ============================================================

  /**
   * GET /api/admin/alerts
   */
  async getAlerts(req: SupabaseRequest, res: Response) {
    try {
      const { adminAlertsService } =
        await import("../services/admin-alerts.service");
      const { page, limit, unread_only, severity, type } = req.query;
      const result = await adminAlertsService.getAlerts(req.supabase, {
        page: parseInt(page as string) || 1,
        limit: parseInt(limit as string) || 30,
        unread_only: unread_only === "true",
        severity: severity as any,
        type: type as any,
      });
      return ApiResponse.success(res, "Alerts retrieved successfully", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get alerts",
      );
    }
  }

  /**
   * PATCH /api/admin/alerts/read — Mark alerts as read
   * Body: { alertIds?: string[] } — if empty marks all
   */
  async markAlertsRead(req: SupabaseRequest, res: Response) {
    try {
      const { adminAlertsService } =
        await import("../services/admin-alerts.service");
      const { alertIds } = req.body;
      if (alertIds?.length) {
        await adminAlertsService.markAsRead(req.supabase, alertIds);
      } else {
        await adminAlertsService.markAllRead(req.supabase);
      }
      return ApiResponse.success(res, "Alerts marked as read", null);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to mark alerts",
      );
    }
  }

  /**
   * GET /api/admin/alerts/unread-count
   */
  async getAlertUnreadCount(req: SupabaseRequest, res: Response) {
    try {
      const { adminAlertsService } =
        await import("../services/admin-alerts.service");
      const count = await adminAlertsService.getUnreadCount(req.supabase);
      return ApiResponse.success(res, "Unread count retrieved", { count });
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get unread count",
      );
    }
  }

  // ============================================================
  // PHASE 2: Webhook Logs
  // ============================================================

  /**
   * GET /api/admin/webhook-logs
   */
  async getWebhookLogs(req: SupabaseRequest, res: Response) {
    try {
      const { webhookLogsService } =
        await import("../services/webhook-logs.service");
      const { page, limit, source, event_type, status, business_id, from, to } =
        req.query;
      const result = await webhookLogsService.getLogs(req.supabase, {
        page: parseInt(page as string) || 1,
        limit: parseInt(limit as string) || 50,
        source: source as string,
        eventType: event_type as string,
        status: status as any,
        businessId: business_id as string,
        from: from as string,
        to: to as string,
      });
      return ApiResponse.success(
        res,
        "Webhook logs retrieved successfully",
        result,
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get webhook logs",
      );
    }
  }

  /**
   * GET /api/admin/webhook-logs/stats
   */
  async getWebhookStats(req: SupabaseRequest, res: Response) {
    try {
      const { webhookLogsService } =
        await import("../services/webhook-logs.service");
      const stats = await webhookLogsService.getStats(req.supabase);
      return ApiResponse.success(res, "Webhook stats retrieved", stats);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to get webhook stats",
      );
    }
  }

  // ============================================================
  // PHASE 2: System Announcements
  // ============================================================

  /**
   * GET /api/admin/announcements
   */
  async listAnnouncements(req: SupabaseRequest, res: Response) {
    try {
      const { systemAnnouncementsService } =
        await import("../services/system-announcements.service");
      const { page, limit, active_only } = req.query;
      const result = await systemAnnouncementsService.list(req.supabase, {
        page: parseInt(page as string) || 1,
        limit: parseInt(limit as string) || 20,
        active_only: active_only === "true",
      });
      return ApiResponse.success(
        res,
        "Announcements retrieved successfully",
        result,
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list announcements",
      );
    }
  }

  /**
   * POST /api/admin/announcements
   */
  async createAnnouncement(req: SupabaseRequest, res: Response) {
    try {
      const { systemAnnouncementsService } =
        await import("../services/system-announcements.service");
      const announcement = await systemAnnouncementsService.create(
        req.supabase,
        {
          ...req.body,
          created_by: req.admin?.id,
        },
      );
      return ApiResponse.created(
        res,
        "Announcement created successfully",
        announcement,
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to create announcement",
      );
    }
  }

  /**
   * PATCH /api/admin/announcements/:id
   */
  async updateAnnouncement(req: SupabaseRequest, res: Response) {
    try {
      const { systemAnnouncementsService } =
        await import("../services/system-announcements.service");
      const announcement = await systemAnnouncementsService.update(
        req.supabase,
        req.params.id,
        req.body,
      );
      return ApiResponse.success(
        res,
        "Announcement updated successfully",
        announcement,
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update announcement",
      );
    }
  }

  /**
   * DELETE /api/admin/announcements/:id
   */
  async deleteAnnouncement(req: SupabaseRequest, res: Response) {
    try {
      const { systemAnnouncementsService } =
        await import("../services/system-announcements.service");
      await systemAnnouncementsService.delete(req.supabase, req.params.id);
      return ApiResponse.success(
        res,
        "Announcement deleted successfully",
        null,
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to delete announcement",
      );
    }
  }

  // ============================================================
  // PHASE 3: Refunds & Disputes
  // ============================================================

  /** GET /api/admin/refunds */
  async listRefunds(req: SupabaseRequest, res: Response) {
    try {
      const { refundsService } = await import("../services/refunds.service");
      const result = await refundsService.listRefunds(req.supabase, {
        status: req.query.status as string,
        business_id: req.query.business_id as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
        from: req.query.from as string,
        to: req.query.to as string,
      });
      return ApiResponse.success(res, "Refunds fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch refunds",
      );
    }
  }

  /** POST /api/admin/refunds */
  async createRefund(req: SupabaseRequest, res: Response) {
    try {
      const { refundsService } = await import("../services/refunds.service");
      const refund = await refundsService.createRefund(req.supabase, {
        ...req.body,
        created_by: req.admin?.id,
      });
      return ApiResponse.created(res, "Refund created", refund);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to create refund",
      );
    }
  }

  /** POST /api/admin/refunds/:id/review */
  async reviewRefund(req: SupabaseRequest, res: Response) {
    try {
      const { refundsService } = await import("../services/refunds.service");
      const result = await refundsService.reviewRefund(
        req.supabase,
        req.params.id,
        req.body.action,
        req.admin?.id || "",
        req.body.admin_notes,
      );
      return ApiResponse.success(res, "Refund reviewed", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to review refund",
      );
    }
  }

  /** GET /api/admin/refunds/stats */
  async getRefundStats(req: SupabaseRequest, res: Response) {
    try {
      const { refundsService } = await import("../services/refunds.service");
      const stats = await refundsService.getRefundStats(req.supabase);
      return ApiResponse.success(res, "Refund stats", stats);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch refund stats",
      );
    }
  }

  /** GET /api/admin/disputes */
  async listDisputes(req: SupabaseRequest, res: Response) {
    try {
      const { refundsService } = await import("../services/refunds.service");
      const result = await refundsService.listDisputes(req.supabase, {
        status: req.query.status as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
      });
      return ApiResponse.success(res, "Disputes fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch disputes",
      );
    }
  }

  /** POST /api/admin/disputes/:id/resolve */
  async resolveDispute(req: SupabaseRequest, res: Response) {
    try {
      const { refundsService } = await import("../services/refunds.service");
      const result = await refundsService.resolveDispute(
        req.supabase,
        req.params.id,
        req.body.resolution,
        req.admin?.id || "",
      );
      return ApiResponse.success(res, "Dispute resolved", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to resolve dispute",
      );
    }
  }

  // ============================================================
  // PHASE 3: KYC Verification
  // ============================================================

  /** GET /api/admin/kyc */
  async listKYC(req: SupabaseRequest, res: Response) {
    try {
      const { kycService } = await import("../services/kyc.service");
      const result = await kycService.listKYC(req.supabase, {
        status: req.query.status as string,
        document_type: req.query.document_type as string,
        business_id: req.query.business_id as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
      });
      return ApiResponse.success(res, "KYC list fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch KYC",
      );
    }
  }

  /** GET /api/admin/kyc/stats */
  async getKYCStats(req: SupabaseRequest, res: Response) {
    try {
      const { kycService } = await import("../services/kyc.service");
      const stats = await kycService.getKYCStats(req.supabase);
      return ApiResponse.success(res, "KYC stats", stats);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch KYC stats",
      );
    }
  }

  /** POST /api/admin/kyc/:id/review */
  async reviewKYC(req: SupabaseRequest, res: Response) {
    try {
      const { kycService } = await import("../services/kyc.service");
      const result = await kycService.reviewKYC(
        req.supabase,
        req.params.id,
        req.body.action,
        req.admin?.id || "",
        req.body.rejection_reason,
      );
      return ApiResponse.success(res, "KYC reviewed", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to review KYC",
      );
    }
  }

  // ============================================================
  // PHASE 3: Fraud Detection
  // ============================================================

  /** GET /api/admin/fraud/signals */
  async listFraudSignals(req: SupabaseRequest, res: Response) {
    try {
      const { fraudDetectionService } =
        await import("../services/fraud-detection.service");
      const result = await fraudDetectionService.listSignals(req.supabase, {
        status: req.query.status as string,
        severity: req.query.severity as string,
        entity_type: req.query.entity_type as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
        from: req.query.from as string,
        to: req.query.to as string,
      });
      return ApiResponse.success(res, "Fraud signals fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch fraud signals",
      );
    }
  }

  /** GET /api/admin/fraud/stats */
  async getFraudStats(req: SupabaseRequest, res: Response) {
    try {
      const { fraudDetectionService } =
        await import("../services/fraud-detection.service");
      const stats = await fraudDetectionService.getFraudStats(req.supabase);
      return ApiResponse.success(res, "Fraud stats", stats);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch fraud stats",
      );
    }
  }

  /** PATCH /api/admin/fraud/signals/:id/review */
  async reviewFraudSignal(req: SupabaseRequest, res: Response) {
    try {
      const { fraudDetectionService } =
        await import("../services/fraud-detection.service");
      const result = await fraudDetectionService.reviewSignal(
        req.supabase,
        req.params.id,
        req.body.status,
        req.admin?.id || "",
        req.body.notes,
      );
      return ApiResponse.success(res, "Fraud signal reviewed", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to review fraud signal",
      );
    }
  }

  // ============================================================
  // PHASE 3: NDPR Compliance
  // ============================================================

  /** GET /api/admin/ndpr */
  async listNDPRRequests(req: SupabaseRequest, res: Response) {
    try {
      const { ndprService } = await import("../services/ndpr.service");
      const result = await ndprService.listRequests(req.supabase, {
        status: req.query.status as string,
        request_type: req.query.request_type as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
      });
      return ApiResponse.success(res, "NDPR requests fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch NDPR requests",
      );
    }
  }

  /** GET /api/admin/ndpr/stats */
  async getNDPRStats(req: SupabaseRequest, res: Response) {
    try {
      const { ndprService } = await import("../services/ndpr.service");
      const stats = await ndprService.getStats(req.supabase);
      return ApiResponse.success(res, "NDPR stats", stats);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch NDPR stats",
      );
    }
  }

  /** PATCH /api/admin/ndpr/:id */
  async updateNDPRRequest(req: SupabaseRequest, res: Response) {
    try {
      const { ndprService } = await import("../services/ndpr.service");
      const result = await ndprService.updateRequest(
        req.supabase,
        req.params.id,
        req.body.status,
        req.admin?.id || "",
        req.body.notes,
        req.body.export_url,
      );
      return ApiResponse.success(res, "NDPR request updated", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update NDPR request",
      );
    }
  }

  /** POST /api/admin/ndpr/:id/export */
  async generateNDPRExport(req: SupabaseRequest, res: Response) {
    try {
      const { ndprService } = await import("../services/ndpr.service");
      const exportData = await ndprService.generateDataExport(
        req.supabase,
        req.body.user_id,
      );
      return ApiResponse.success(res, "Data export generated", exportData);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to generate export",
      );
    }
  }

  // ============================================================
  // PHASE 4: Customer Health Score
  // ============================================================

  /** GET /api/admin/health/overview */
  async getHealthOverview(req: SupabaseRequest, res: Response) {
    try {
      const { customerHealthService } =
        await import("../services/customer-health.service");
      const result = await customerHealthService.getHealthOverview(
        req.supabase,
        {
          tier: req.query.tier as string,
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
        },
      );
      return ApiResponse.success(res, "Health overview fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch health overview",
      );
    }
  }

  /** GET /api/admin/health/summary */
  async getHealthSummary(req: SupabaseRequest, res: Response) {
    try {
      const { customerHealthService } =
        await import("../services/customer-health.service");
      const summary = await customerHealthService.getTierSummary(req.supabase);
      return ApiResponse.success(res, "Health summary", summary);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch health summary",
      );
    }
  }

  /** GET /api/admin/health/:businessId */
  async getBusinessHealth(req: SupabaseRequest, res: Response) {
    try {
      const { customerHealthService } =
        await import("../services/customer-health.service");
      const score = await customerHealthService.computeScore(
        req.supabase,
        req.params.businessId,
      );
      return ApiResponse.success(res, "Health score computed", score);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to compute health score",
      );
    }
  }

  // ============================================================
  // PHASE 4: Helpdesk
  // ============================================================

  /** GET /api/admin/helpdesk/stats */
  async getHelpdeskStats(req: SupabaseRequest, res: Response) {
    try {
      const { helpdeskService } = await import("../services/helpdesk.service");
      const stats = await helpdeskService.getStats(req.supabase);
      return ApiResponse.success(res, "Helpdesk stats", stats);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch helpdesk stats",
      );
    }
  }

  /** GET /api/admin/helpdesk/tickets */
  async listTickets(req: SupabaseRequest, res: Response) {
    try {
      const { helpdeskService } = await import("../services/helpdesk.service");
      const result = await helpdeskService.listTickets(req.supabase, {
        status: req.query.status as string,
        priority: req.query.priority as string,
        category: req.query.category as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
        search: req.query.search as string,
      });
      return ApiResponse.success(res, "Tickets fetched", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch tickets",
      );
    }
  }

  /** GET /api/admin/helpdesk/tickets/:id */
  async getTicket(req: SupabaseRequest, res: Response) {
    try {
      const { helpdeskService } = await import("../services/helpdesk.service");
      const ticket = await helpdeskService.getTicket(
        req.supabase,
        req.params.id,
      );
      return ApiResponse.success(res, "Ticket fetched", ticket);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch ticket",
      );
    }
  }

  /** PATCH /api/admin/helpdesk/tickets/:id */
  async updateTicket(req: SupabaseRequest, res: Response) {
    try {
      const { helpdeskService } = await import("../services/helpdesk.service");
      const ticket = await helpdeskService.updateTicket(
        req.supabase,
        req.params.id,
        req.body,
      );
      return ApiResponse.success(res, "Ticket updated", ticket);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update ticket",
      );
    }
  }

  /** POST /api/admin/helpdesk/tickets/:id/reply */
  async replyToTicket(req: SupabaseRequest, res: Response) {
    try {
      const { helpdeskService } = await import("../services/helpdesk.service");
      const reply = await helpdeskService.addReply(
        req.supabase,
        req.params.id,
        {
          ...req.body,
          author_id: req.admin?.id,
        },
      );
      return ApiResponse.created(res, "Reply added", reply);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to add reply",
      );
    }
  }

  // ============================================================
  // PHASE 4: NPS
  // ============================================================

  /** GET /api/admin/nps/summary */
  async getNPSSummary(req: SupabaseRequest, res: Response) {
    try {
      const { npsService } = await import("../services/nps.service");
      const summary = await npsService.getSummary(
        req.supabase,
        req.query.from as string,
        req.query.to as string,
      );
      return ApiResponse.success(res, "NPS summary", summary);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch NPS summary",
      );
    }
  }

  /** GET /api/admin/nps/responses */
  async listNPSResponses(req: SupabaseRequest, res: Response) {
    try {
      const { npsService } = await import("../services/nps.service");
      const result = await npsService.listResponses(req.supabase, {
        category: req.query.category as string,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 50,
        from: req.query.from as string,
        to: req.query.to as string,
      });
      return ApiResponse.success(res, "NPS responses", result);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch NPS responses",
      );
    }
  }

  /** GET /api/admin/nps/feedback */
  async getNPSFeedback(req: SupabaseRequest, res: Response) {
    try {
      const { npsService } = await import("../services/nps.service");
      const feedback = await npsService.getQualitativeFeedback(
        req.supabase,
        req.query.category as any,
        Number(req.query.limit) || 20,
      );
      return ApiResponse.success(res, "NPS qualitative feedback", feedback);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch NPS feedback",
      );
    }
  }

  // ============================================================
  // AI Agent (Command Center panel) settings
  // ============================================================

  /** GET /api/admin/ai-agent-settings — current agent panel config. */
  async getAiAgentSettings(req: SupabaseRequest, res: Response) {
    try {
      const { getAgentSettings, isAgentPanelEnabled } = await import(
        "../services/ai/agent-settings.service"
      );
      const settings = await getAgentSettings();
      return ApiResponse.success(res, "AI agent settings fetched", {
        ...settings,
        env_enabled: process.env.AI_AGENT_ENABLED === "true",
        effective_enabled: await isAgentPanelEnabled(),
      });
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch AI agent settings",
      );
    }
  }

  /** PUT /api/admin/ai-agent-settings — upsert the agent flag row. */
  async updateAiAgentSettings(req: SupabaseRequest, res: Response) {
    try {
      const { enabled, provider, model } = req.body as {
        enabled?: boolean;
        provider?: string;
        model?: string;
      };
      const ALLOWED_PROVIDERS = [
        "anthropic",
        "gemini",
        "openai",
        "ollama",
        "mock",
      ];
      if (provider && !ALLOWED_PROVIDERS.includes(provider)) {
        return ApiResponse.badRequest(
          res,
          `provider must be one of: ${ALLOWED_PROVIDERS.join(", ")}`,
        );
      }

      const {
        AGENT_FLAG_KEY,
        invalidateAgentSettingsCache,
        getAgentSettings,
        isAgentPanelEnabled,
      } = await import("../services/ai/agent-settings.service");
      const { supabaseAdmin } = await import("../config/supabase");

      const { error } = await supabaseAdmin.from("feature_flags").upsert(
        {
          key: AGENT_FLAG_KEY,
          name: "AI Agent Panel",
          description:
            "Dashboard AI assistant (Command Center panel). Metadata holds provider/model overrides.",
          enabled: enabled ?? true,
          metadata: {
            provider: provider || null,
            model: model || null,
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
      if (error) throw new Error(error.message);

      invalidateAgentSettingsCache();

      const settings = await getAgentSettings();
      return ApiResponse.success(res, "AI agent settings updated", {
        ...settings,
        env_enabled: process.env.AI_AGENT_ENABLED === "true",
        effective_enabled: await isAgentPanelEnabled(),
      });
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update AI agent settings",
      );
    }
  }

  /**
   * GET /api/admin/ai-agent-capabilities — what the agent can actually do,
   * read straight off the registered tool builders rather than hand-copied
   * text, so this can never drift from what's really wired up. Built with
   * placeholder context (empty ids, a no-op emit) since only each tool's
   * name/description is read here — execute() is never called.
   */
  async getAiAgentCapabilities(req: SupabaseRequest, res: Response) {
    try {
      const { buildQaTools } = await import("../services/ai/tools/qa.tools");
      const { buildExtractionTool } = await import(
        "../services/ai/tools/store-creation.tool"
      );

      const qaTools = buildQaTools({
        userId: "",
        businessId: "",
        supabase: null as any,
      });
      const extractionTool = buildExtractionTool({
        sessionKey: "",
        businessId: "",
        userId: "",
        emit: () => {},
      });

      const describe = (tool: { name: string; description: string }) => ({
        name: tool.name,
        description: tool.description,
      });

      return ApiResponse.success(res, "AI agent capabilities fetched", {
        qa_tools: qaTools.map(describe),
        actions: [extractionTool].map(describe),
      });
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch AI agent capabilities",
      );
    }
  }

  // ============================================================
  // PHASE 4: Feature Flags
  // ============================================================

  /** GET /api/admin/feature-flags */
  async listFeatureFlags(req: SupabaseRequest, res: Response) {
    try {
      const { featureFlagsService } =
        await import("../services/feature-flags.service");
      const flags = await featureFlagsService.listFlags(req.supabase, {
        search: req.query.search as string,
        enabled_only: req.query.enabled_only === "true",
      });
      return ApiResponse.success(res, "Feature flags fetched", flags);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch feature flags",
      );
    }
  }

  /** POST /api/admin/feature-flags */
  async createFeatureFlag(req: SupabaseRequest, res: Response) {
    try {
      const { featureFlagsService } =
        await import("../services/feature-flags.service");
      const flag = await featureFlagsService.createFlag(req.supabase, req.body);
      return ApiResponse.created(res, "Feature flag created", flag);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to create feature flag",
      );
    }
  }

  /** PATCH /api/admin/feature-flags/:id */
  async updateFeatureFlag(req: SupabaseRequest, res: Response) {
    try {
      const { featureFlagsService } =
        await import("../services/feature-flags.service");
      const flag = await featureFlagsService.updateFlag(
        req.supabase,
        req.params.id,
        req.body,
      );
      return ApiResponse.success(res, "Feature flag updated", flag);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update feature flag",
      );
    }
  }

  /** DELETE /api/admin/feature-flags/:id */
  async deleteFeatureFlag(req: SupabaseRequest, res: Response) {
    try {
      const { featureFlagsService } =
        await import("../services/feature-flags.service");
      await featureFlagsService.deleteFlag(req.supabase, req.params.id);
      return ApiResponse.success(res, "Feature flag deleted", null);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to delete feature flag",
      );
    }
  }

  // ============================================================
  // PHASE 5: Revenue Forecast
  // ============================================================
  async getRevenueForecast(req: SupabaseRequest, res: Response) {
    try {
      const { revenueForecastService } =
        await import("../services/revenue-forecast.service");
      const forecast = await revenueForecastService.getForecast(
        req.supabase,
        Number(req.query.forecast_months) || 6,
        Number(req.query.history_months) || 6,
      );
      return ApiResponse.success(res, "Revenue forecast", forecast);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to generate forecast",
      );
    }
  }

  // ============================================================
  // Payout Requests (read-only tracking)
  // ============================================================
  async listPayoutRequests(req: SupabaseRequest, res: Response) {
    try {
      const adminClient = this.getAdminClient(req);
      const { status, page = 1, limit = 50 } = req.query;
      const pageNumber = Number(page);
      const pageSize = Number(limit);
      const offset = (pageNumber - 1) * pageSize;

      let query = adminClient
        .from("payout_requests")
        .select("*, businesses:business_id (name)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (status && status !== "all") {
        query = query.eq("status", status as string);
      }

      const { data, count, error } = await query;
      if (error) throw error;

      return ApiResponse.success(res, "Payout requests retrieved", {
        requests: data || [],
        pagination: {
          total: count || 0,
          page: pageNumber,
          limit: pageSize,
        },
      });
    } catch (error: any) {
      console.error("[AdminController.listPayoutRequests] Error:", error);
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch payout requests",
      );
    }
  }

  // ============================================================
  // PHASE 5: Leaderboards
  // ============================================================
  async getRevenueLeaderboard(req: SupabaseRequest, res: Response) {
    try {
      const { leaderboardsService } =
        await import("../services/leaderboards.service");
      const data = await leaderboardsService.getTopByRevenue(req.supabase, {
        limit: Number(req.query.limit) || 20,
        from: req.query.from as string,
        to: req.query.to as string,
      });
      return ApiResponse.success(res, "Revenue leaderboard", data);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch revenue leaderboard",
      );
    }
  }

  async getOrdersLeaderboard(req: SupabaseRequest, res: Response) {
    try {
      const { leaderboardsService } =
        await import("../services/leaderboards.service");
      const data = await leaderboardsService.getTopByOrders(req.supabase, {
        limit: Number(req.query.limit) || 20,
        from: req.query.from as string,
        to: req.query.to as string,
      });
      return ApiResponse.success(res, "Orders leaderboard", data);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch orders leaderboard",
      );
    }
  }

  async getMostActiveBusinesses(req: SupabaseRequest, res: Response) {
    try {
      const { leaderboardsService } =
        await import("../services/leaderboards.service");
      const data = await leaderboardsService.getMostActive(
        req.supabase,
        Number(req.query.limit) || 20,
      );
      return ApiResponse.success(res, "Most active businesses", data);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch active businesses",
      );
    }
  }

  async getNewestPaidBusinesses(req: SupabaseRequest, res: Response) {
    try {
      const { leaderboardsService } =
        await import("../services/leaderboards.service");
      const data = await leaderboardsService.getNewestPaidBusinesses(
        req.supabase,
        Number(req.query.limit) || 20,
      );
      return ApiResponse.success(res, "Newest paid businesses", data);
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch newest paid businesses",
      );
    }
  }

  // --------------------------------------------------------------------------
  // Cron Job Management
  // --------------------------------------------------------------------------

  async listCronJobs(_req: SupabaseRequest, res: Response) {
    try {
      const { SchedulerService } =
        await import("../services/scheduler.service");
      return ApiResponse.success(
        res,
        "Cron jobs",
        SchedulerService.JOB_DEFINITIONS,
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to list cron jobs",
      );
    }
  }

  async runCronJob(req: SupabaseRequest, res: Response) {
    const { jobId } = req.params;
    try {
      const { schedulerService } =
        await import("../services/scheduler.service");
      const start = Date.now();
      await schedulerService.runJob(jobId);
      const duration = Date.now() - start;

      const adminService = new AdminService(req.supabase);
      await adminService.logAction({
        adminUserId: req.user_id!,
        action: "run_cron_job",
        targetType: "cron_job",
        targetId: jobId,
        afterData: { duration_ms: duration },
      });

      return ApiResponse.success(
        res,
        `Job '${jobId}' completed in ${duration}ms`,
        { duration_ms: duration },
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || `Failed to run job '${jobId}'`,
      );
    }
  }
  // ============================================================
  // ADM-001: Marketplace Suppression
  // ============================================================

  private static readonly ENTITY_TABLE_MAP: Record<string, string> = {
    product: "products",
    event: "events",
    circle: "circles",
  };

  /**
   * Toggle marketplace visibility for a single item.
   * PATCH /api/admin/marketplace/suppress
   * Body: { entity_type, entity_id, hidden }
   */
  async suppressMarketplaceItem(req: SupabaseRequest, res: Response) {
    try {
      const { entity_type, entity_id, hidden } = req.body as {
        entity_type: string;
        entity_id: string;
        hidden: boolean;
      };

      const table = AdminController.ENTITY_TABLE_MAP[entity_type];
      if (!table) {
        return ApiResponse.badRequest(
          res,
          `Invalid entity_type. Must be one of: ${Object.keys(AdminController.ENTITY_TABLE_MAP).join(", ")}`,
        );
      }
      if (typeof hidden !== "boolean") {
        return ApiResponse.badRequest(res, "hidden must be a boolean");
      }

      const adminClient = this.getAdminClient(req);
      const { error } = await adminClient
        .from(table)
        .update({ marketplace_hidden: hidden })
        .eq("id", entity_id);

      if (error) throw error;

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: hidden
            ? "marketplace.suppress_item"
            : "marketplace.restore_item",
          targetType: entity_type,
          targetId: entity_id,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return ApiResponse.success(
        res,
        hidden
          ? "Item hidden from marketplace"
          : "Item restored to marketplace",
        { entity_type, entity_id, marketplace_hidden: hidden },
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to update marketplace visibility",
      );
    }
  }

  /**
   * Bulk suppress all items of one entity type for a business.
   * PATCH /api/admin/marketplace/suppress/business/:businessId
   * Body: { entity_type, hidden }
   */
  async bulkSuppressBusinessItems(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const { entity_type, hidden } = req.body as {
        entity_type: string;
        hidden: boolean;
      };

      const table = AdminController.ENTITY_TABLE_MAP[entity_type];
      if (!table) {
        return ApiResponse.badRequest(
          res,
          `Invalid entity_type. Must be one of: ${Object.keys(AdminController.ENTITY_TABLE_MAP).join(", ")}`,
        );
      }
      if (typeof hidden !== "boolean") {
        return ApiResponse.badRequest(res, "hidden must be a boolean");
      }

      const businessColumn =
        entity_type === "product" ? "store_id" : "business_id";

      // Products are scoped by store, not directly by business_id
      const adminClient = this.getAdminClient(req);
      let updateQuery: any;
      if (entity_type === "product") {
        // Find all store ids for this business first
        const { data: stores, error: storeError } = await adminClient
          .from("stores")
          .select("id")
          .eq("business_id", businessId);

        if (storeError) throw storeError;

        const storeIds = (stores || []).map((s: any) => s.id);
        if (storeIds.length === 0) {
          return ApiResponse.success(res, "No stores found for this business", {
            updated: 0,
          });
        }

        const { error, count } = await adminClient
          .from("products")
          .update({ marketplace_hidden: hidden })
          .in("store_id", storeIds);

        if (error) throw error;

        updateQuery = { count };
      } else {
        const { error, count } = await adminClient
          .from(table)
          .update({ marketplace_hidden: hidden })
          .eq(businessColumn, businessId);

        if (error) throw error;
        updateQuery = { count };
      }

      if (req.admin) {
        const adminService = new AdminService(req.supabase);
        await adminService.logAction({
          adminUserId: req.admin.id,
          action: hidden
            ? "marketplace.bulk_suppress_business"
            : "marketplace.bulk_restore_business",
          targetType: "business",
          targetId: businessId,
          afterData: { entity_type, count: updateQuery.count },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return ApiResponse.success(
        res,
        hidden
          ? `All ${entity_type}s hidden from marketplace`
          : `All ${entity_type}s restored to marketplace`,
        { entity_type, marketplace_hidden: hidden, updated: updateQuery.count },
      );
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to bulk update marketplace visibility",
      );
    }
  }

  /**
   * List ALL items of one entity type with their marketplace_hidden state.
   * GET /api/admin/marketplace/items?entity_type=product|event|circle&search=&page=&limit=
   */
  async listMarketplaceItems(req: SupabaseRequest, res: Response) {
    try {
      const {
        entity_type = "product",
        search = "",
        page = "1",
        limit = "20",
      } = req.query as {
        entity_type?: string;
        search?: string;
        page?: string;
        limit?: string;
      };

      const table = AdminController.ENTITY_TABLE_MAP[entity_type];
      if (!table) {
        return ApiResponse.badRequest(
          res,
          `Invalid entity_type. Must be one of: ${Object.keys(AdminController.ENTITY_TABLE_MAP).join(", ")}`,
        );
      }

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, parseInt(limit) || 20);
      const offset = (pageNum - 1) * limitNum;

      const adminClient = this.getAdminClient(req);

      const selectFields =
        entity_type === "product"
          ? "id, name, status, marketplace_hidden, created_at, store:stores(id, name, business:businesses(id, name, marketplace_visibility))"
          : entity_type === "event"
            ? "id, event_name, status, marketplace_hidden, created_at, business:businesses(id, name, marketplace_visibility)"
            : "id, title, visibility, marketplace_hidden, created_at, business:businesses(id, name, marketplace_visibility)";

      const searchColumn =
        entity_type === "product"
          ? "name"
          : entity_type === "event"
            ? "event_name"
            : "title";

      let query = adminClient
        .from(table)
        .select(selectFields, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (search) {
        query = query.ilike(searchColumn, `%${search}%`);
      }

      const { data, error, count } = await query;

      if (error) throw error;

      return ApiResponse.success(res, "Marketplace items retrieved", {
        items: data || [],
        pagination: {
          total: count || 0,
          page: pageNum,
          limit: limitNum,
        },
      });
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch marketplace items",
      );
    }
  }

  /**
   * List marketplace-suppressed items (for admin review panel).
   * GET /api/admin/marketplace/suppressed?entity_type=product|event|circle
   */
  async listSuppressedItems(req: SupabaseRequest, res: Response) {
    try {
      const { entity_type = "product", page = "1", limit = "20" } = req.query as {
        entity_type?: string;
        page?: string;
        limit?: string;
      };

      const table = AdminController.ENTITY_TABLE_MAP[entity_type];
      if (!table) {
        return ApiResponse.badRequest(
          res,
          `Invalid entity_type. Must be one of: ${Object.keys(AdminController.ENTITY_TABLE_MAP).join(", ")}`,
        );
      }

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, parseInt(limit) || 20);
      const offset = (pageNum - 1) * limitNum;

      const adminClient = this.getAdminClient(req);
      const selectFields =
        entity_type === "product"
          ? "id, name, status, created_at, store:stores(id, name, business:businesses(id, name))"
          : entity_type === "event"
            ? "id, event_name, status, created_at, business:businesses(id, name)"
            : "id, title, visibility, created_at, business:businesses(id, name)";

      const { data, error, count } = await adminClient
        .from(table)
        .select(selectFields, { count: "exact" })
        .eq("marketplace_hidden", true)
        .order("created_at", { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (error) throw error;

      return ApiResponse.success(res, "Suppressed items retrieved", {
        items: data || [],
        pagination: {
          total: count || 0,
          page: pageNum,
          limit: limitNum,
        },
      });
    } catch (error: any) {
      return ApiResponse.serverError(
        res,
        error?.message || "Failed to fetch suppressed items",
      );
    }
  }

  /**
   * List an event's ticket types for manual order reconstruction in the
   * Payment Recovery tool.
   */
  async getEventTickets(req: SupabaseRequest, res: Response) {
    try {
      const { eventId } = req.params as { eventId: string };
      const adminClient = this.getAdminClient(req);

      const { data, error } = await adminClient
        .from("event_tickets")
        .select(
          "id, ticket_name, ticket_price, available_quantity, quantity_sold",
        )
        .eq("event_id", eventId)
        .order("ticket_price", { ascending: true });

      if (error) throw new Error(error.message);

      return ApiResponse.success(res, "Event tickets loaded", data ?? []);
    } catch (error: any) {
      return ApiResponse.error(
        res,
        error?.message ?? "Failed to load event tickets",
        500,
      );
    }
  }

  /**
   * Fulfill an unresolved payment into an event using admin-supplied checkout
   * data (event + tickets + buyer email). Rebuilds the payment metadata Paystack
   * stripped from bank-transfer transactions and runs the normal event
   * fulfillment pipeline — order, ticket issuance, and emails.
   */
  async fulfillEventOrder(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);
      const { event_id, email, name, tickets } = req.body as {
        event_id?: string;
        email?: string;
        name?: string;
        tickets?: Array<{ ticket_id: string; quantity: number }>;
      };

      if (!event_id || !email) {
        return ApiResponse.badRequest(res, "event_id and email are required");
      }
      if (!tickets || tickets.length === 0) {
        return ApiResponse.badRequest(
          res,
          "At least one ticket selection is required",
        );
      }
      const selections = tickets.filter(
        (ticket) => ticket?.ticket_id && Number(ticket.quantity) > 0,
      );
      if (selections.length === 0) {
        return ApiResponse.badRequest(
          res,
          "At least one ticket must have a quantity greater than zero",
        );
      }

      const { webhookController } = require("./webhook.controller");
      const paymentData = await webhookController
        .verifyPaymentForRecovery(reference)
        .catch(() => null);
      if (!paymentData || paymentData.status !== "success") {
        return ApiResponse.error(
          res,
          paymentData
            ? `Payment status is "${paymentData.status}" — cannot fulfill`
            : "Payment could not be verified by its provider",
          422,
        );
      }

      const ticketIds = selections.map((selection) => selection.ticket_id);
      const { data: ticketRows, error: ticketsError } = await adminClient
        .from("event_tickets")
        .select("id, ticket_name, ticket_price, event_id")
        .in("id", ticketIds);
      if (ticketsError) throw new Error(ticketsError.message);

      const rowsById = new Map(
        (ticketRows ?? []).map((row: any) => [row.id, row]),
      );
      const foreignTicket = selections.find(
        (selection) =>
          !rowsById.has(selection.ticket_id) ||
          rowsById.get(selection.ticket_id)?.event_id !== event_id,
      );
      if (foreignTicket) {
        return ApiResponse.badRequest(
          res,
          `Ticket ${foreignTicket.ticket_id} does not belong to the selected event`,
        );
      }

      const { data: existingOrder } = await adminClient
        .from("orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle();
      if (existingOrder) {
        return ApiResponse.success(res, "Payment already fulfilled", {
          alreadyProcessed: true,
          orderId: existingOrder.id,
        });
      }

      const selectedTickets = Object.fromEntries(
        selections.map((selection) => [
          selection.ticket_id,
          Number(selection.quantity),
        ]),
      );

      await webhookController.fulfillEventPurchase({
        reference,
        amount: paymentData.amount,
        status: "success",
        currency: paymentData.currency,
        provider: paymentData.provider,
        paidAt: paymentData.paidAt,
        customer: {
          email,
          name: name || "",
          first_name: name?.split(" ")[0],
          last_name: name?.split(" ").slice(1).join(" ") || undefined,
        },
        metadata: {
          transaction_type: "event_ticket",
          event_id,
          email,
          full_name: name || "",
          selectedTickets,
          tickets: ticketRows ?? [],
          recipients: [],
          custom_answers: {},
        },
      });

      const { data: order } = await adminClient
        .from("orders")
        .select("id, event_id, total_amount, created_at")
        .eq("payment_reference", reference)
        .maybeSingle();

      this.resolveRecoveryQueueEntry(adminClient, reference, req.user_id);

      return ApiResponse.success(res, "Event order fulfilled", {
        alreadyProcessed: false,
        order,
      });
    } catch (error: any) {
      return ApiResponse.error(
        res,
        error?.message ?? "Failed to fulfill event order",
        500,
      );
    }
  }

  /**
   * Look up a payment reference across the provider and local checkout/order
   * records. A pending checkout is the provider-independent source of the
   * original checkout metadata when a webhook did not create an order.
   */
  async lookupPayment(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);

      // Fetch core order data without confirmation_email_sent_at — the column may
      // not exist yet if the migration hasn't run. We fetch the timestamp separately
      // so a missing column can't silently null-out the entire row.
      const [pendingCheckout, storeOrderResult, eventOrderResult] = await Promise.all([
        pendingCheckoutService.findByReference(adminClient, reference),
        adminClient
          .from("store_orders")
          .select("id, status, created_at, total")
          .eq("payment_reference", reference)
          .maybeSingle(),
        // `orders` (event tickets) has no status column — select only what exists
        adminClient
          .from("orders")
          .select("id, event_id, total_amount, created_at")
          .eq("payment_reference", reference)
          .maybeSingle(),
      ]);

      const provider = PaymentProviderFactory.getProviderForReference(reference);
      const paymentData = await provider.verifyPayment(reference).catch(() => null);
      const providerName = paymentData?.provider ?? provider.name;
      const resolvedMetadata = {
        ...(paymentData?.metadata ?? {}),
        ...(pendingCheckout?.metadata ?? {}),
      };

      const storeOrderData = storeOrderResult.data ?? null;
      const eventOrderData = eventOrderResult.data ?? null;

      // Fetch email timestamps independently so a missing column doesn't break lookup
      const [storeEmailResult, eventEmailResult] = await Promise.all([
        storeOrderData
          ? adminClient
              .from("store_orders")
              .select("confirmation_email_sent_at")
              .eq("id", storeOrderData.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        eventOrderData
          ? adminClient
              .from("orders")
              .select("confirmation_email_sent_at")
              .eq("id", eventOrderData.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      const storeOrder = storeOrderData
        ? { ...storeOrderData, confirmation_email_sent_at: storeEmailResult.data?.confirmation_email_sent_at ?? null }
        : null;
      const eventTicketCountResult = eventOrderData
        ? await adminClient
            .from("issued_tickets")
            .select("id", { count: "exact", head: true })
            .eq("order_id", eventOrderData.id)
        : { count: null };
      const eventOrder = eventOrderData
        ? {
            ...eventOrderData,
            confirmation_email_sent_at:
              eventEmailResult.data?.confirmation_email_sent_at ?? null,
            issued_ticket_count: eventTicketCountResult.count ?? 0,
          }
        : null;

      // VA deposits are fulfilled by a wallet credit, not an order row — surface
      // the credit so admins see it was handled instead of a missed webhook.
      const isDedicatedNubanDeposit =
        paymentData?.authorization?.channel === "dedicated_nuban" &&
        !storeOrder &&
        !eventOrder;
      const { data: walletTransaction } = isDedicatedNubanDeposit
        ? await adminClient
            .from("wallet_transactions")
            .select(
              "id, type, direction, amount, status, provider_reference, description, gross_amount, fee_amount, fee_breakdown, posted_at, created_at",
            )
            .eq("provider", "paystack")
            .eq("provider_reference", reference)
            .maybeSingle()
        : { data: null };

      // When Paystack strips checkout metadata (bank transfers), the subaccount is
      // the only reliable link back to the business — use it to surface candidate
      // events/stores so admins can match the payment and recover the order.
      const subaccountCode =
        pendingCheckout?.subaccount_code ??
        paymentData?.subaccountCode ??
        undefined;
      const flwSubaccountId =
        pendingCheckout?.metadata?.flw_subaccount_id ??
        paymentData?.providerSubaccountId ??
        undefined;

      let business: Record<string, unknown> | null = null;
      let businessId = resolvedMetadata.business_id;

      if (!businessId && resolvedMetadata.store_id) {
        const { data: store } = await adminClient
          .from("stores")
          .select("business_id")
          .eq("id", resolvedMetadata.store_id)
          .maybeSingle();
        businessId = store?.business_id ?? undefined;
      }

      if (!businessId && resolvedMetadata.event_id) {
        const { data: event } = await adminClient
          .from("events")
          .select("business_id")
          .eq("id", resolvedMetadata.event_id)
          .maybeSingle();
        businessId = event?.business_id ?? undefined;
      }

      if (businessId) {
        const { data } = await adminClient
          .from("businesses")
          .select("id, name, paystack_subaccount_code, flw_subaccount_id")
          .eq("id", businessId)
          .maybeSingle();
        business = data ?? null;
      } else if (subaccountCode || flwSubaccountId) {
        let query = adminClient
          .from("businesses")
          .select("id, name, paystack_subaccount_code, flw_subaccount_id");
        query = subaccountCode
          ? query.eq("paystack_subaccount_code", subaccountCode)
          : query.eq("flw_subaccount_id", flwSubaccountId);
        const { data } = await query.maybeSingle();
        business = data ?? null;
      }

      let events: any[] = [];
      let stores: any[] = [];
      let matchedEvent: Record<string, unknown> | null = null;
      if (business) {
        const [eventsResult, storesResult] = await Promise.all([
          adminClient
            .from("events")
            .select("id, event_name, start_date, start_time, status")
            .eq("business_id", business.id)
            .order("start_date", { ascending: false })
            .limit(10),
          adminClient
            .from("stores")
            .select("id, name, status")
            .eq("business_id", business.id)
            .limit(10),
        ]);
        events = eventsResult.data ?? [];
        stores = storesResult.data ?? [];

        // EVT-<eventIdPrefix>-<timestamp> — the embedded id prefix identifies
        // the exact event the buyer purchased from.
        const evtPrefix = reference.startsWith("EVT-")
          ? reference.split("-")[1]
          : null;
        if (evtPrefix) {
          matchedEvent =
            (events as any[]).find((e: any) => e.id.startsWith(evtPrefix)) ??
            null;
        }
      }

      return ApiResponse.success(res, "Payment lookup complete", {
        provider: providerName,
        payment: paymentData
          ? {
              status: paymentData.status,
              amount: paymentData.amount,
              currency: paymentData.currency,
              paidAt: paymentData.paidAt,
              customerEmail:
                paymentData.metadata?.email ?? paymentData.customer?.email,
              customerName:
                paymentData.metadata?.full_name ??
                paymentData.metadata?.customer_name ??
                paymentData.customer?.name,
              channel: paymentData.channel,
              metadata: resolvedMetadata,
              raw: paymentData.raw ?? null,
            }
          : null,
        pendingCheckout,
        paystack: paymentData?.provider === "paystack"
          ? {
              status: paymentData.status,
              amount: paymentData.amount,
              currency: paymentData.currency,
              paidAt: paymentData.paidAt,
              customerEmail:
                paymentData.metadata?.email ?? paymentData.customer?.email,
              customerName:
                paymentData.metadata?.full_name ??
                paymentData.metadata?.customer_name ??
                paymentData.customer?.name,
              channel: paymentData.channel,
              metadata: resolvedMetadata,
              raw: paymentData.raw ?? null,
            }
          : null,
        business,
        matchedEvent,
        events,
        stores,
        storeOrder,
        eventOrder,
        walletTransaction,
      });
    } catch (error: any) {
      return ApiResponse.error(res, error.message ?? "Lookup failed", 500);
    }
  }

  /**
   * Resend confirmation emails for an order that is already in the DB but whose
   * emails were never dispatched (confirmation_email_sent_at IS NULL).
   */
  async resendOrderEmails(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);

      // Try event order first — select only stable columns; email timestamp fetched separately
      const { data: eventOrder } = await adminClient
        .from("orders")
        .select("id, event_id")
        .eq("payment_reference", reference)
        .maybeSingle();

      if (eventOrder) {
        const { webhookController } = require("./webhook.controller");
        await webhookController.resendEventOrderEmails(eventOrder.id, adminClient);
        await adminClient
          .from("orders")
          .update({ confirmation_email_sent_at: new Date().toISOString() })
          .eq("id", eventOrder.id);
        this.resolveRecoveryQueueEntry(adminClient, reference, req.user_id);
        return ApiResponse.success(res, "Event order emails resent", { type: "event", orderId: eventOrder.id });
      }

      // Try store order
      const { data: storeOrder } = await adminClient
        .from("store_orders")
        .select("id, store_id")
        .eq("payment_reference", reference)
        .maybeSingle();

      if (storeOrder) {
        const { webhookController } = require("./webhook.controller");
        await webhookController.resendStoreOrderEmails(storeOrder.id, adminClient);
        const { error: stampError } = await adminClient
          .from("store_orders")
          .update({ confirmation_email_sent_at: new Date().toISOString() })
          .eq("id", storeOrder.id);
        if (stampError) {
          console.error("[Admin] Failed to stamp confirmation_email_sent_at:", stampError);
        }
        this.resolveRecoveryQueueEntry(adminClient, reference, req.user_id);
        return ApiResponse.success(res, "Store order emails resent", { type: "store", orderId: storeOrder.id });
      }

      return ApiResponse.error(res, "No order found for this reference", 404);
    } catch (error: any) {
      return ApiResponse.error(res, error.message ?? "Resend failed", 500);
    }
  }

  /**
   * Verify a Paystack reference and fulfill the order if not already processed.
   */
  async fulfillPayment(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);

      const { webhookController } = require("./webhook.controller");
      const result = await webhookController.replayWebhook(reference);

      if (result.fulfilled) {
        this.resolveRecoveryQueueEntry(adminClient, reference, req.user_id);
      }

      return ApiResponse.success(res, "Fulfill attempt complete", result);
    } catch (error: any) {
      return ApiResponse.error(res, error.message ?? "Fulfill failed", 500);
    }
  }

  /**
   * Complete a partially-processed event ticket order: order row exists, but
   * ticket issuance and/or confirmation emails did not finish.
   */
  async recoverEventFulfillment(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);

      const { webhookController } = require("./webhook.controller");
      const result =
        await webhookController.recoverEventOrderFulfillment(reference);

      if (result.ticketsIssued > 0 || result.emailsSent) {
        this.resolveRecoveryQueueEntry(adminClient, reference, req.user_id);
      }

      return ApiResponse.success(
        res,
        "Event fulfillment recovery complete",
        result,
      );
    } catch (error: any) {
      return ApiResponse.error(
        res,
        error.message ?? "Event fulfillment recovery failed",
        500,
      );
    }
  }

  /**
   * List unresolved entries from the payment_recovery_queue (most recent first).
   * These are Paystack successes with no matching order row, surfaced by the cron.
   */
  async listRecoveryQueue(req: SupabaseRequest, res: Response) {
    try {
      const adminClient = this.getAdminClient(req);
      const { data, error } = await adminClient
        .from("payment_recovery_queue")
        .select("id, payment_reference, paystack_amount, paystack_email, paystack_paid_at, paystack_metadata, created_at")
        .is("resolved_at", null)
        .order("paystack_paid_at", { ascending: false })
        .limit(50);

      if (error) throw new Error(error.message);

      return ApiResponse.success(res, "Recovery queue loaded", data ?? []);
    } catch (error: any) {
      return ApiResponse.error(res, error.message ?? "Failed to load recovery queue", 500);
    }
  }

  /**
   * Mark a recovery queue entry as resolved (fire-and-forget — not critical path).
   */
  private resolveRecoveryQueueEntry(adminClient: any, reference: string, resolvedBy?: string): void {
    adminClient
      .from("payment_recovery_queue")
      .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy ?? null })
      .eq("payment_reference", reference)
      .is("resolved_at", null)
      .then(({ error }: { error: any }) => {
        if (error) console.error("[Admin] Failed to resolve recovery queue entry:", error.message);
      });
  }

  // ============================================
  // TRANSFER RECOVERY (withdrawals)
  // Deliberately separate from payment lookup so withdrawal recovery never
  // collides with checkout payments or virtual-account deposits.
  // ============================================

  private async findWithdrawalByReference(
    client: SupabaseClient,
    reference: string,
  ) {
    const fields =
      "id, business_id, amount, currency, bank_code, account_number, account_name, status, provider_reference, provider_transfer_code, failure_reason, created_at, updated_at";
    const query =
      reference.startsWith("TRF_")
        ? client
            .from("banking_withdrawals")
            .select(fields)
            .eq("provider_transfer_code", reference)
        : client
            .from("banking_withdrawals")
            .select(fields)
            .eq("provider_reference", reference);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data;
  }

  /**
   * Look up a withdrawal transfer by its provider reference or Paystack
   * transfer code, surfacing the live Paystack status alongside the
   * database row.
   */
  async lookupTransfer(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);
      const withdrawal = await this.findWithdrawalByReference(
        adminClient,
        reference,
      );

      let paystack = null;
      if (withdrawal?.provider_transfer_code) {
        paystack = await getPaystackTransfer(
          withdrawal.provider_transfer_code,
        ).catch(() => null);
      }

      return ApiResponse.success(res, "Transfer lookup complete", {
        withdrawal,
        paystack,
      });
    } catch (error: any) {
      return ApiResponse.error(res, error.message ?? "Transfer lookup failed", 500);
    }
  }

  /**
   * Finalize a pending withdrawal with the OTP that Paystack delivered to the
   * business owner (RSA authorization). Mirrors the business-side flow.
   */
  async finalizeTransfer(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const { otp } = (req.body ?? {}) as { otp?: string };
      if (!otp || !otp.trim()) {
        return ApiResponse.badRequest(res, "OTP is required");
      }

      const adminClient = this.getAdminClient(req);
      const withdrawal = await this.findWithdrawalByReference(
        adminClient,
        reference,
      );
      if (!withdrawal) {
        return ApiResponse.notFound(res, "Transfer not found");
      }
      if (!withdrawal.provider_transfer_code) {
        return ApiResponse.badRequest(
          res,
          "Transfer has no provider transfer code to finalize",
        );
      }

      const service = new BankingService(adminClient);
      const finalized = await service.finalizeWithdrawal({
        business_id: withdrawal.business_id,
        transfer_code: withdrawal.provider_transfer_code,
        otp: otp.trim(),
      });

      return ApiResponse.success(res, "Transfer finalized", {
        withdrawal: finalized,
      });
    } catch (error: any) {
      return ApiResponse.error(
        res,
        error?.message ?? "Transfer finalize failed",
        error?.statusCode ?? 500,
      );
    }
  }

  /**
   * Pull the live Paystack status for a transfer and reconcile the database
   * row: settle the wallet debit on success, mark failed/reversed (and reverse
   * the wallet debit) otherwise. Non-terminal Paystack statuses just refresh
   * the view.
   */
  async syncTransfer(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params as { reference: string };
      const adminClient = this.getAdminClient(req);
      const withdrawal = await this.findWithdrawalByReference(
        adminClient,
        reference,
      );
      if (!withdrawal) {
        return ApiResponse.notFound(res, "Transfer not found");
      }
      if (!withdrawal.provider_transfer_code) {
        return ApiResponse.badRequest(
          res,
          "Transfer has no provider transfer code to sync",
        );
      }

      const paystack = await getPaystackTransfer(
        withdrawal.provider_transfer_code,
      );
      const terminalStatuses: Record<string, "success" | "failed" | "reversed"> = {
        success: "success",
        failed: "failed",
        reversed: "reversed",
      };
      if (terminalStatuses[paystack.status]) {
        const service = new BankingService(adminClient);
        await service.handleTransferEvent(
          {
            reference: paystack.reference,
            transfer_code: paystack.transfer_code,
            reason:
              paystack.status === "failed"
                ? "Failed via admin sync"
                : paystack.status === "reversed"
                  ? "Reversed via admin sync"
                  : null,
          },
          terminalStatuses[paystack.status],
        );
      }

      const refreshed = await this.findWithdrawalByReference(
        adminClient,
        reference,
      );
      return ApiResponse.success(res, "Transfer synced", {
        withdrawal: refreshed,
        paystack,
      });
    } catch (error: any) {
      return ApiResponse.error(res, error.message ?? "Transfer sync failed", 500);
    }
  }
}

export const adminController = new AdminController();
