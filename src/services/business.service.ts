import { SupabaseClient } from "@supabase/supabase-js";
import {
  type FeeBearer,
  type SettlementSchedule,
  DEFAULT_SETTLEMENT_SCHEDULE,
  isSettlementSchedule,
} from "../types/payment";
import { StorageService } from "./storage.service";
import { SYSTEM_ROLES } from "../types/teams";
import { createHash, randomInt, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "../config/supabaseAdmin";
import { emailService } from "./email.service";

const SETTLEMENT_VERIFICATION_TABLE = "settlement_account_change_verifications";
const SETTLEMENT_VERIFICATION_TTL_MINUTES = 10;
const SETTLEMENT_VERIFICATION_MAX_ATTEMPTS = 5;

const hashSettlementCode = (businessId: string, userId: string, code: string) =>
  createHash("sha256")
    .update(`${businessId}:${userId}:${code}`)
    .digest("hex");

const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "your email address";
  const visible = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
};

export interface SubaccountSettings {
  business_name: string | null;
  settlement_bank: string | null;
  account_number: string | null;
  subaccount_code: string | null;
  paystack_fee_bearer: FeeBearer;
  settlement_schedule: SettlementSchedule;
  flw_subaccount_id: string | null;
  flw_country: string | null;
}

export interface Business {
  id: string;
  owner_user_id: string;
  name: string;
  status: string;
  slug?: string;
  cover_image?: string;
  logo_url?: string;
  primary_color?: string;
  description?: string;
  support_email?: string;
  support_phone?: string;
  currency?: string;
  timezone?: string;
  social_links?: any;
  address?: any;
  policies?: any;
  marketplace_visibility?: string;

  [key: string]: any;
}

export interface BusinessWithRole extends Business {
  role: string;
}

export interface CreateBusinessInput {
  name: string;
  category_slug?: string;
  sub_category_slug?: string;
}

export interface UpdateBusinessInput {
  name?: string;
  slug?: string;
  marketplace_visibility?: boolean;
  cover_image?: string;
  logo_url?: string;
  primary_color?: string;
  description?: string;
  support_email?: string;
  support_phone?: string;
  currency?: string;
  timezone?: string;
  social_links?: any;
  address?: any;
  policies?: any;
  category_slug?: string;
  sub_category_slug?: string;
}

interface Category {
  id: string;
  slug: string;
  label: string;
  subcategories?: Category[];
}

/**
 * Business Service
 * Handles all business-related operations
 */
export class BusinessService {
  private storageService: StorageService;
  constructor(private supabase: SupabaseClient) {
    this.storageService = new StorageService(supabase);
  }

  /**
   * Get all businesses for a user (owned + member)
   */
  async getUserBusinesses(userId: string): Promise<BusinessWithRole[]> {
    // Get businesses where user is owner
    const { data: owned, error: ownedError } = await this.supabase
      .from("businesses")
      .select("*")
      .eq("owner_user_id", userId);

    if (ownedError) throw ownedError;

    // Get businesses where user is a member (but not owner)
    const { data: memberships, error: memberError } = await this.supabase
      .from("memberships")
      .select(
        `
        business:businesses(*),
        role:roles(name)
      `,
      )
      .eq("user_id", userId)
      .eq("status", "active");

    if (memberError) throw memberError;

    // Combine and deduplicate
    const memberBusinesses =
      memberships
        ?.map((m: any) => ({ ...m.business, role: m.role?.name }))
        .filter((b: any) => b && !owned?.some((o: any) => o.id === b.id)) || [];

    const ownedWithRole =
      owned?.map((b: any) => ({ ...b, role: SYSTEM_ROLES.OWNER })) || [];

    return [...ownedWithRole, ...memberBusinesses];
  }

  /**
   * Get a single business by ID
   */
  async getBusinessById(businessId: string): Promise<Business | null> {
    const { data, error } = await this.supabase
      .from("businesses")
      .select("*")
      .eq("id", businessId)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }

    return data;
  }

  /**
   * Get a single business by slug
   */
  async getBusinessBySlug(slug: string): Promise<Business | null> {
    const { data, error } = await this.supabase
      .from("businesses")
      .select("*, store:stores(*)")
      .eq("slug", slug)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }

    // Ensure store is returned as a single object (or null), not an array
    if (data && Array.isArray(data.store)) {
      data.store = data.store[0] || null;
    }

    return data;
  }

  /**
   * Get enriched public business profile by slug — includes content (events,
   * products, publication) for the elevated /b/[slug] creator page.
   */
  async getBusinessPublicProfile(slug: string): Promise<any | null> {
    const business = await this.getBusinessBySlug(slug);
    if (!business) return null;

    // Owner info
    const { data: owner } = await this.supabase
      .from("users")
      .select("username, name, avatar_url")
      .eq("id", business.owner_user_id)
      .single();

    // Events — filter by business_id, fall back to owner_id for older events
    let eventsResult = await this.supabase
      .from("events")
      .select(
        "event_name, id, status, event_url, cover_image, start_date, start_time, end_time, venue, is_physical, is_online",
        { count: "exact" },
      )
      .eq("business_id", business.id)
      .in("status", ["published", "active"])
      .order("start_date", { ascending: true })
      .limit(6);

    if (eventsResult.error) {
      console.error(
        "[BusinessService] Events query error:",
        eventsResult.error.message,
      );
    }

    // Fall back to owner_id if no events found via business_id
    if (!eventsResult.data?.length && !eventsResult.error) {
      eventsResult = await this.supabase
        .from("events")
        .select(
          "event_name, id, status, event_url, cover_image, start_date, start_time, end_time, venue, is_physical, is_online",
          { count: "exact" },
        )
        .eq("owner_id", business.owner_user_id)
        .in("status", ["published", "active"])
        .order("start_date", { ascending: true })
        .limit(6);

      if (eventsResult.error) {
        console.error(
          "[BusinessService] Events fallback query error:",
          eventsResult.error.message,
        );
      }
    }

    const events = eventsResult.data || [];
    const eventsCount = eventsResult.count || events.length;

    // Products — use store id from business.store (already loaded)
    let products: any[] = [];
    let productsCount = 0;
    const storeId = business.store?.id;
    if (storeId) {
      const {
        data: productRows,
        count: pc,
        error: productError,
      } = await this.supabase
        .from("products")
        .select("id, name, price, cover_image", { count: "exact" })
        .eq("store_id", storeId)
        .limit(10);

      if (productError) {
        console.error(
          "[BusinessService] Products query error:",
          productError.message,
        );
      } else {
        products = productRows || [];
        productsCount = pc || 0;
      }
    }

    // Publications — a business can have multiple; subscribers is a uuid[]
    // column, so derive the count from its length.
    const { data: publicationRows, error: pubError } = await this.supabase
      .from("publications")
      .select("id, name, slug, profile_image, description, subscribers")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false });

    if (pubError) {
      console.error("[BusinessService] Publications query error:", pubError);
    }

    const publications = (publicationRows || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      profile_image: p.profile_image,
      description: p.description,
      subscribers_count: Array.isArray(p.subscribers)
        ? p.subscribers.length
        : 0,
    }));

    return {
      ...business,
      owner: owner ?? null,
      events: events || [],
      eventsCount: eventsCount || 0,
      products,
      productsCount,
      publications,
      publicationsCount: publications.length,
    };
  }

  /**
   * Check if user has any businesses
   */
  async userHasBusinesses(userId: string): Promise<boolean> {
    console.log(
      `[BusinessService] Checking if user ${userId} has businesses...`,
    );

    // Check if user owns any business
    const { data: owned, error: ownedError } = await this.supabase
      .from("businesses")
      .select("id")
      .eq("owner_user_id", userId)
      .limit(1);

    if (ownedError) {
      console.error(
        "[BusinessService] Error checking owned businesses:",
        ownedError,
      );
      throw ownedError;
    }

    console.log(
      `[BusinessService] Owned businesses found: ${owned?.length || 0}`,
    );

    if (owned && owned.length > 0) {
      return true;
    }

    // Check if user is a member of any business
    const { data: memberships, error: memberError } = await this.supabase
      .from("memberships")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1);

    if (memberError) {
      console.error(
        "[BusinessService] Error checking memberships:",
        memberError,
      );
      throw memberError;
    }

    console.log(
      `[BusinessService] Memberships found: ${memberships?.length || 0}`,
    );

    return memberships && memberships.length > 0;
  }

  /**
   * Create a new business with owner membership
   */
  /**
   * Slugify a string into a URL-friendly base slug.
   */
  private slugify(value: string): string {
    const base = (value || "business")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return base || "business";
  }

  /**
   * Generate a slug from a name that is unique within the businesses table.
   */
  private async generateUniqueBusinessSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let candidate = base;

    for (let attempt = 0; attempt < 10; attempt++) {
      const { data, error } = await this.supabase
        .from("businesses")
        .select("id")
        .eq("slug", candidate)
        .limit(1);

      if (error) break;
      if (!data || data.length === 0) return candidate;

      // Collision — append a short random suffix and retry
      candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    }

    return candidate;
  }

  async createBusiness(
    userId: string,
    input: CreateBusinessInput,
  ): Promise<Business> {
    // 1. Validate sub-category if provided
    if (input.sub_category_slug && input.category_slug) {
      await this.validateSubCategory(
        input.category_slug,
        input.sub_category_slug,
      );
    }

    // 2. Create business (with a unique slug derived from the name)
    const slug = await this.generateUniqueBusinessSlug(input.name);

    const { data: business, error } = await this.supabase
      .from("businesses")
      .insert([
        {
          owner_user_id: userId,
          name: input.name,
          slug,
          category_slug: input.category_slug,
          sub_category_slug: input.sub_category_slug,
          status: "active", // Keep existing status
        },
      ])
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        throw new Error("Business name already exists");
      }
      throw error;
    }

    if (!business) {
      throw new Error("Failed to create business - no data returned");
    }

    // 3. Add owner as member with 'owner' role
    const { data: ownerRole, error: roleError } = await this.supabase
      .from("roles")
      .select("id")
      .eq("name", SYSTEM_ROLES.OWNER)
      .eq("is_system", true)
      .single();

    if (roleError) {
      console.error("[BusinessService] Failed to fetch Owner role:", roleError);
    }

    if (ownerRole) {
      const { error: membershipError } = await this.supabase
        .from("memberships")
        .insert({
          business_id: business.id,
          user_id: userId,
          role_id: ownerRole.id,
          status: "active",
          joined_at: new Date().toISOString(),
        });

      if (membershipError) {
        console.error(
          "[BusinessService] Failed to create membership:",
          membershipError,
        );
      }
    } else {
      console.error(
        "[BusinessService] Owner role not found - membership not created!",
      );
    }

    // 4. Attach user's existing content to this new business
    try {
      const attachedCounts = await this.attachUserContentToBusiness(
        userId,
        business.id,
      );
      const totalAttached = Object.values(attachedCounts).reduce(
        (sum, count) => sum + count,
        0,
      );
      if (totalAttached > 0) {
        console.log(
          "[BusinessService] Attached user content to business:",
          attachedCounts,
        );
      }
    } catch (attachError: any) {
      console.error(
        "[BusinessService] Failed to attach user content:",
        attachError.message,
      );
    }

    return business;
  }

  /**
   * Update business details
   */
  async updateBusiness(
    businessId: string,
    userId: string,
    input: UpdateBusinessInput,
  ): Promise<Business> {
    // Check if user is owner (retained from original code, as the instruction's comment was a suggestion)
    const { data: businessCheck, error: checkError } = await this.supabase
      .from("businesses")
      .select("owner_user_id, category_slug") // Also select category_slug for validation
      .eq("id", businessId)
      .single();

    if (checkError || !businessCheck) {
      throw Object.assign(new Error("Business not found"), { statusCode: 404 });
    }

    const isOwner = businessCheck.owner_user_id === userId;
    if (!isOwner) {
      throw Object.assign(
        new Error("Unauthorized: Only the owner can update business settings"),
        {
          statusCode: 403,
        },
      );
    }

    // Build update data
    const updateData: any = {};
    const fields = [
      "name",
      "slug",
      "marketplace_visibility",
      "cover_image",
      "logo_url",
      "primary_color",
      "description",
      "support_email",
      "support_phone",
      "currency",
      "timezone",
      "social_links",
      "address",
      "policies",
    ];

    for (const field of fields) {
      if ((input as any)[field] !== undefined) {
        updateData[field] = (input as any)[field];
      }
    }

    const { data, error } = await this.supabase
      .from("businesses")
      .update(updateData)
      .eq("id", businessId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        throw Object.assign(new Error("Slug already exists"), {
          statusCode: 409,
        });
      }
      throw error;
    }

    return data;
  }

  /**
   * Delete (soft) a business
   */
  async deleteBusiness(businessId: string): Promise<void> {
    const { error } = await this.supabase
      .from("businesses")
      .update({ status: "deleted" })
      .eq("id", businessId);

    if (error) throw error;
  }

  /**
   * Attach all user-created content (where business_id is NULL) to the specified business.
   */
  async attachUserContentToBusiness(
    userId: string,
    businessId: string,
  ): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    const tableConfigs = [
      { table: "publications", userIdColumn: "user_id" },
      { table: "events", userIdColumn: "owner_id" },
      { table: "websites", userIdColumn: "user_id" },
      { table: "contacts", userIdColumn: "user_id" },
      { table: "segments", userIdColumn: "user_id" },
      { table: "campaigns", userIdColumn: "user_id" },
      { table: "availability_profiles", userIdColumn: "owner_id" },
    ];

    for (const config of tableConfigs) {
      try {
        const { data, error } = await this.supabase
          .from(config.table)
          .update({ business_id: businessId })
          .eq(config.userIdColumn, userId)
          .is("business_id", null)
          .select("id");

        if (error) {
          console.warn(
            `[BusinessService] Failed to attach ${config.table}:`,
            error.message,
          );
          results[config.table] = 0;
        } else {
          results[config.table] = data?.length || 0;
          if (results[config.table] > 0) {
            console.log(
              `[BusinessService] Attached ${results[config.table]} ${config.table} to business ${businessId}`,
            );
          }
        }
      } catch (err: any) {
        console.warn(
          `[BusinessService] Error attaching ${config.table}:`,
          err.message,
        );
        results[config.table] = 0;
      }
    }

    return results;
  }
  /**
   * Get all business categories in a tree structure
   */
  async getBusinessCategories(): Promise<Category[]> {
    const { data: categories, error } = await this.supabase
      .from("business_categories")
      .select("id, slug, label, parent_id")
      .eq("is_active", true)
      .order("label", { ascending: true });

    if (error) throw error;

    const categoryMap = new Map<string, Category>();
    const rootCategories: Category[] = [];

    // First pass: Create category objects and map them
    categories.forEach((cat) => {
      categoryMap.set(cat.id, {
        id: cat.id,
        slug: cat.slug,
        label: cat.label,
        subcategories: [], // Initialize empty array
      });
    });

    // Second pass: Build the tree
    categories.forEach((cat) => {
      const category = categoryMap.get(cat.id)!;
      if (cat.parent_id) {
        const parent = categoryMap.get(cat.parent_id);
        if (parent) {
          parent.subcategories!.push(category);
        }
      } else {
        rootCategories.push(category);
      }
    });

    return rootCategories;
  }

  /**
   * Validate that a sub-category belongs to a parent category
   */
  private async validateSubCategory(
    categorySlug: string,
    subCategorySlug: string,
  ): Promise<boolean> {
    interface CategoryWithParent {
      slug: string;
      parent: { slug: string } | null;
    }
    const { data, error } = await this.supabase
      .from("business_categories")
      .select("slug, parent:parent_id(slug)")
      .eq("slug", subCategorySlug)
      .single<CategoryWithParent>();

    if (error || !data) {
      throw new Error(`Invalid sub-category: ${subCategorySlug}`);
    }

    const parentSlug = data.parent?.slug;

    if (parentSlug !== categorySlug) {
      throw new Error(
        `Sub-category '${subCategorySlug}' does not belong to category '${categorySlug}'`,
      );
    }

    return true;
  }

  /**
   * Get a single category by its slug
   */
  async getCategoryBySlug(slug: string): Promise<Category | null> {
    const { data, error } = await this.supabase
      .from("business_categories")
      .select("id, slug, label, icon, description, parent_id")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }

    return data;
  }

  // ===========================================================================
  // Subaccount Management
  // ===========================================================================

  /**
   * Get business subaccount settings with Paystack details
   */
  async getSubaccountSettings(
    businessId: string,
  ): Promise<SubaccountSettings> {
    const { data, error } = await this.supabase
      .from("businesses")
      .select(
        "name, paystack_subaccount_code, paystack_fee_bearer, paystack_settlement_schedule, flw_subaccount_id, flw_country",
      )
      .eq("id", businessId)
      .single();

    if (error) {
      throw Object.assign(new Error("Business not found"), { statusCode: 404 });
    }

    const sharedBase = {
      settlement_schedule:
        data.paystack_settlement_schedule || DEFAULT_SETTLEMENT_SCHEDULE,
      flw_subaccount_id: data.flw_subaccount_id || null,
      flw_country: data.flw_country || null,
    };

    // If no Paystack subaccount set, return minimal info + shared fields
    if (!data.paystack_subaccount_code) {
      return {
        business_name: data.name || null,
        settlement_bank: null,
        account_number: null,
        subaccount_code: null,
        paystack_fee_bearer: data.paystack_fee_bearer || "subaccount",
        ...sharedBase,
      };
    }

    // Fetch full details from Paystack
    try {
      const { fetchPaystackSubaccount } =
        await import("../utils/paystack.util");
      const paystackData = await fetchPaystackSubaccount(
        data.paystack_subaccount_code,
      );

      return {
        business_name: paystackData.business_name || data.name,
        settlement_bank: paystackData.settlement_bank || null,
        account_number: paystackData.account_number || null,
        subaccount_code: data.paystack_subaccount_code,
        paystack_fee_bearer: data.paystack_fee_bearer || "customer",
        ...sharedBase,
      };
    } catch (paystackErr) {
      console.error(
        "[getSubaccountSettings] Paystack fetch error:",
        paystackErr,
      );
      return {
        business_name: data.name || null,
        settlement_bank: null,
        account_number: null,
        subaccount_code: data.paystack_subaccount_code,
        paystack_fee_bearer: data.paystack_fee_bearer || "subaccount",
        ...sharedBase,
      };
    }
  }

  async requestSettlementAccountVerification(
    businessId: string,
    userId: string,
    email: string,
  ): Promise<{ email: string; expires_at: string }> {
    if (!supabaseAdmin) {
      throw Object.assign(new Error("Verification service unavailable"), { statusCode: 503 });
    }
    if (!email || !email.includes("@")) {
      throw Object.assign(new Error("No verified account email is available"), { statusCode: 400 });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SETTLEMENT_VERIFICATION_TTL_MINUTES * 60_000);
    const code = randomInt(100000, 1000000).toString();
    const tokenHash = hashSettlementCode(businessId, userId, code);

    await supabaseAdmin
      .from(SETTLEMENT_VERIFICATION_TABLE)
      .update({ consumed_at: now.toISOString() })
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .is("consumed_at", null);

    const { data, error } = await supabaseAdmin
      .from(SETTLEMENT_VERIFICATION_TABLE)
      .insert({
        business_id: businessId,
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) throw Object.assign(new Error("Could not create verification challenge"), { statusCode: 500 });

    try {
      await emailService.sendSettlementAccountVerificationEmail({
        to: email,
        code,
        expiresInMinutes: SETTLEMENT_VERIFICATION_TTL_MINUTES,
      });
    } catch (sendError) {
      await supabaseAdmin.from(SETTLEMENT_VERIFICATION_TABLE).delete().eq("id", data.id);
      throw Object.assign(new Error("Could not send verification email"), { statusCode: 503, cause: sendError });
    }

    return { email: maskEmail(email), expires_at: expiresAt.toISOString() };
  }

  async consumeSettlementAccountVerification(
    businessId: string,
    userId: string,
    code: string | undefined,
  ): Promise<void> {
    if (!supabaseAdmin) {
      throw Object.assign(new Error("Verification service unavailable"), { statusCode: 503 });
    }
    if (!code || !/^\d{6}$/.test(code)) {
      throw Object.assign(new Error("Enter the 6-digit verification code"), { statusCode: 400 });
    }

    const { data: challenge, error } = await supabaseAdmin
      .from(SETTLEMENT_VERIFICATION_TABLE)
      .select("id, token_hash, attempts, expires_at")
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .lt("attempts", SETTLEMENT_VERIFICATION_MAX_ATTEMPTS)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !challenge) {
      throw Object.assign(new Error("Verification code is invalid or expired"), { statusCode: 400 });
    }

    const expected = Buffer.from(challenge.token_hash, "hex");
    const received = Buffer.from(hashSettlementCode(businessId, userId, code), "hex");
    const matches = expected.length === received.length && timingSafeEqual(expected, received);
    if (!matches) {
      const attempts = Number(challenge.attempts || 0) + 1;
      await supabaseAdmin
        .from(SETTLEMENT_VERIFICATION_TABLE)
        .update({ attempts, ...(attempts >= SETTLEMENT_VERIFICATION_MAX_ATTEMPTS ? { consumed_at: new Date().toISOString() } : {}) })
        .eq("id", challenge.id);
      throw Object.assign(new Error("Verification code is invalid or expired"), { statusCode: 400 });
    }

    const { error: consumeError } = await supabaseAdmin
      .from(SETTLEMENT_VERIFICATION_TABLE)
      .update({ verified_at: new Date().toISOString(), consumed_at: new Date().toISOString() })
      .eq("id", challenge.id)
      .is("consumed_at", null);
    if (consumeError) throw Object.assign(new Error("Could not confirm verification code"), { statusCode: 500 });
  }

  /**
   * Update business subaccount settings — creates/updates both Paystack (NGN)
   * and Flutterwave (non-NGN) subaccounts from a single call.
   *
   * Paystack fields: settlement_bank (NG bank code), account_number, paystack_fee_bearer
   * Flutterwave fields: flw_bank_code, flw_account_number, flw_country
   *   flw_country is the ISO code used to scope the FLW bank list ("NG", "GH", "KE", etc.)
   *   If flw_* fields are omitted, the FLW subaccount is left unchanged.
   */
  async updateSubaccount(
    businessId: string,
    settings: {
      // Shared
      business_name?: string;
      // Paystack (NGN)
      settlement_bank?: string;
      account_number?: string;
      paystack_fee_bearer?: FeeBearer;
      settlement_schedule?: SettlementSchedule;
      // Flutterwave (non-NGN)
      flw_bank_code?: string;
      flw_account_number?: string;
      flw_country?: string;
      business_email?: string;
      verification_code?: string;
    },
    verificationUserId?: string,
  ): Promise<SubaccountSettings> {
    const changesSettlementAccount = [
      settings.settlement_bank,
      settings.account_number,
      settings.flw_bank_code,
      settings.flw_account_number,
    ].some((value) => value !== undefined);

    if (changesSettlementAccount) {
      await this.consumeSettlementAccountVerification(
        businessId,
        verificationUserId || (await this.supabase.auth.getUser()).data.user?.id || "",
        settings.verification_code,
      );
    }
    if (
      settings.settlement_schedule !== undefined &&
      !isSettlementSchedule(settings.settlement_schedule)
    ) {
      throw Object.assign(
        new Error(
          "settlement_schedule must be one of auto, weekly, monthly, manual",
        ),
        { statusCode: 400 },
      );
    }

    // 1. Load current business
    const business = await this.getBusinessById(businessId);
    if (!business) {
      throw Object.assign(new Error("Business not found"), { statusCode: 404 });
    }

    const bizName =
      settings.business_name || (business as any).name || "Business";
    const existingPaystackCode = (business as any)?.paystack_subaccount_code;
    const existingFlwId = (business as any)?.flw_subaccount_id as
      | string
      | undefined;

    // 2. Paystack subaccount (NGN) — create or update
    if (
      settings.settlement_bank ||
      settings.account_number ||
      settings.business_name ||
      settings.settlement_schedule
    ) {
      const { createPaystackSubaccount, updatePaystackSubaccount } =
        await import("../utils/paystack.util");

      const pData: any = { business_name: bizName, percentage_charge: 0 };
      if (settings.settlement_bank)
        pData.settlement_bank = settings.settlement_bank;
      if (settings.account_number)
        pData.account_number = settings.account_number;
      if (settings.settlement_schedule)
        pData.settlement_schedule = settings.settlement_schedule;

      if (existingPaystackCode) {
        await updatePaystackSubaccount(existingPaystackCode, pData);
      } else {
        if (!settings.settlement_bank || !settings.account_number) {
          throw new Error(
            "settlement_bank and account_number are required to create a Paystack subaccount",
          );
        }
        const sub = await createPaystackSubaccount({
          business_name: bizName,
          settlement_bank: settings.settlement_bank,
          account_number: settings.account_number,
          percentage_charge: 0,
          settlement_schedule: settings.settlement_schedule,
        });
        await this.updateSubaccountSettings(businessId, {
          paystack_subaccount_code: sub.subaccount_code,
          paystack_subaccount_id: sub.id,
        });
      }

      // Sync FLW (NG) subaccount whenever bank details touch the Paystack path.
      // FLW does not allow changing account_number/account_bank on an existing subaccount,
      // so when bank details change we always create a fresh one.
      // When only business_name changed (no new bank/account) we update in place.
      const bankDetailsChanged = !!(
        settings.settlement_bank || settings.account_number
      );
      if (bankDetailsChanged) {
        // Need the final bank code and account number to use for FLW.
        const flwBankCode =
          settings.settlement_bank || (business as any)?.settlement_bank;
        const flwAccountNumber =
          settings.account_number || (business as any)?.account_number;

        if (flwBankCode && flwAccountNumber) {
          try {
            // Resolve email: prefer explicitly passed email, then business support_email,
            // then owner's auth email — FLW requires a non-empty business_email.
            let businessEmail =
              settings.business_email || (business as any)?.support_email || "";
            if (!businessEmail && (business as any)?.owner_user_id) {
              try {
                const {
                  data: { user },
                } = await this.supabase.auth.admin.getUserById(
                  (business as any).owner_user_id,
                );
                businessEmail = user?.email ?? "";
              } catch {
                // fall through with empty string — FLW will reject, caught below
              }
            }

            const { getFlutterwaveBanks, createFlutterwaveSubaccount } =
              await import("../utils/flutterwave.util");
            const flwBanks = await getFlutterwaveBanks("NG");
            const matched = flwBanks.find((b) => b.code === flwBankCode);
            if (matched) {
              const flwSub = await createFlutterwaveSubaccount({
                account_number: flwAccountNumber,
                account_bank: matched.code,
                business_name: bizName,
                country: "NG",
                business_email: businessEmail,
              });
              await this.updateSubaccountSettings(businessId, {
                flw_subaccount_id: flwSub.subaccount_id,
                flw_country: "NG",
              });
            } else {
              console.warn(
                `[updateSubaccount] No FLW bank matched Paystack code ${flwBankCode} — FLW subaccount not synced`,
              );
            }
          } catch (flwErr: any) {
            const detail: string =
              flwErr?.response?.data?.message ?? flwErr?.message ?? "";
            // FLW already has a subaccount for this account+bank — fetch and store it.
            if (detail.toLowerCase().includes("already exists")) {
              try {
                const axios = (await import("axios")).default;
                const flwKey = process.env.FLW_SECRET_KEY!;
                const res = await axios.get(
                  `https://api.flutterwave.com/v3/subaccounts?account_number=${flwAccountNumber}&account_bank=${flwBankCode}`,
                  {
                    headers: { Authorization: `Bearer ${flwKey}` },
                    timeout: 10_000,
                  },
                );
                const existing = res.data?.data?.[0];
                if (existing?.subaccount_id) {
                  await this.updateSubaccountSettings(businessId, {
                    flw_subaccount_id: existing.subaccount_id,
                    flw_country: "NG",
                  });
                  console.log(
                    `[updateSubaccount] Recovered existing FLW subaccount: subaccount_id=${existing.subaccount_id}`,
                  );
                } else {
                  console.error(
                    "[updateSubaccount] FLW already-exists recovery: no subaccount in response",
                  );
                }
              } catch (recoverErr: any) {
                console.error(
                  "[updateSubaccount] FLW already-exists recovery failed:",
                  recoverErr?.message ?? recoverErr,
                );
              }
            } else {
              // Non-fatal: Paystack subaccount is already saved; log and continue.
              console.error(
                "[updateSubaccount] FLW subaccount sync failed:",
                detail,
              );
            }
          }
        }
      } else if (existingFlwId && settings.business_name) {
        // Only the name changed — update the existing FLW subaccount in place.
        try {
          const { updateFlutterwaveSubaccount } =
            await import("../utils/flutterwave.util");
          await updateFlutterwaveSubaccount(existingFlwId, {
            business_name: bizName,
          });
        } catch (flwErr: any) {
          console.error(
            "[updateSubaccount] FLW name update failed:",
            flwErr?.message ?? flwErr,
          );
        }
      }
    }

    // 3. Flutterwave subaccount (non-NGN or explicit override) — create or update
    if (
      settings.flw_bank_code ||
      settings.flw_account_number ||
      settings.flw_country
    ) {
      const { createFlutterwaveSubaccount, updateFlutterwaveSubaccount } =
        await import("../utils/flutterwave.util");

      const flwCountry =
        settings.flw_country || (business as any)?.flw_country || "NG";
      const flwData = {
        account_number:
          settings.flw_account_number ||
          (business as any)?.account_number ||
          "",
        account_bank: settings.flw_bank_code || "",
        business_name: bizName,
        country: flwCountry,
        business_email: settings.business_email || "",
      };

      if (existingFlwId) {
        await updateFlutterwaveSubaccount(existingFlwId, flwData);
        if (settings.flw_country) {
          await this.updateSubaccountSettings(businessId, {
            flw_subaccount_id: existingFlwId,
            flw_country: flwCountry,
          });
        }
      } else {
        if (!settings.flw_bank_code || !settings.flw_account_number) {
          throw new Error(
            "flw_bank_code and flw_account_number are required to create a Flutterwave subaccount",
          );
        }
        const flwSub = await createFlutterwaveSubaccount(flwData);
        await this.updateSubaccountSettings(businessId, {
          flw_subaccount_id: flwSub.subaccount_id,
          flw_country: flwCountry,
        });
      }
    }

    // 4. Fee bearer + settlement schedule.
    // Only default the fee bearer on first setup; on later updates leave it
    // untouched when the caller didn't send one, so changing the schedule
    // alone doesn't reset it.
    const feeBearer =
      settings.paystack_fee_bearer ??
      (existingPaystackCode ? undefined : "customer");
    await this.updateSubaccountSettings(businessId, {
      paystack_fee_bearer: feeBearer,
      paystack_settlement_schedule: settings.settlement_schedule,
    });

    return this.getSubaccountSettings(businessId);
  }

  /**
   * Internal helper: Update business subaccount settings in DB
   */
  async updateSubaccountSettings(
    businessId: string,
    settings: {
      paystack_subaccount_code?: string;
      paystack_subaccount_id?: number;
      paystack_fee_bearer?: FeeBearer;
      paystack_settlement_schedule?: SettlementSchedule;
      flw_subaccount_id?: string;
      flw_country?: string;
    },
  ): Promise<void> {
    const updateData: Record<string, unknown> = {};

    if (settings.paystack_subaccount_code !== undefined)
      updateData.paystack_subaccount_code = settings.paystack_subaccount_code;
    if (settings.paystack_subaccount_id !== undefined)
      updateData.paystack_subaccount_id = settings.paystack_subaccount_id;
    if (settings.paystack_fee_bearer !== undefined)
      updateData.paystack_fee_bearer = settings.paystack_fee_bearer;
    if (settings.paystack_settlement_schedule !== undefined)
      updateData.paystack_settlement_schedule =
        settings.paystack_settlement_schedule;
    if (settings.flw_subaccount_id !== undefined)
      updateData.flw_subaccount_id = settings.flw_subaccount_id;
    if (settings.flw_country !== undefined)
      updateData.flw_country = settings.flw_country;

    const { error } = await this.supabase
      .from("businesses")
      .update(updateData)
      .eq("id", businessId);

    if (error) throw error;
  }

  /**
   * Upload image (logo or banner) for a business
   */
  async uploadBusinessImage(
    businessId: string,
    type: "logo" | "banner",
    file: Express.Multer.File,
  ) {
    const fileExt = file.originalname.split(".").pop();
    const fileName = `${type}_${Date.now()}.${fileExt}`;
    const filePath = `businesses/${businessId}/${type}/${fileName}`;

    const bucket = "businesses";
    return this.storageService.uploadFile(bucket, filePath, file, true);
  }
}

export default BusinessService;
