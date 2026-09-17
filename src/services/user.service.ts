import { SupabaseClient } from "@supabase/supabase-js";
import { StorageService } from "./storage.service";

type ThemePreference = "light" | "dark" | "system";

interface MulterFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * User Service
 * Handles user preferences and profile-related operations
 */
export class UserService {
  private storageService: StorageService;
  constructor(private supabase: SupabaseClient) {
    this.storageService = new StorageService(supabase);
  }

  /**
   * Get user preferences (last active store/publication + general preferences)
   */
  async getUserPreferences(userId: string): Promise<{
    last_active_store_id: string | null;
    last_active_publication_id: string | null;
    timezone: string;
    currency: string;
    locale: string;
    theme: ThemePreference;
    [key: string]: any;
  }> {
    // Get last_active from user_preferences table
    const { data: prefData, error: prefError } = await this.supabase
      .from("user_preferences")
      .select("last_active_store_id, last_active_publication_id")
      .eq("user_id", userId)
      .single();

    if (prefError && prefError.code !== "PGRST116") throw prefError;

    // Get general preferences from users table
    const { data: userData, error: userError } = await this.supabase
      .from("users")
      .select("preferences")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    const defaults = {
      timezone: "Africa/Lagos",
      currency: "NGN",
      locale: "en",
      theme: "light" as ThemePreference,
      onboarding_completed: false,
    };

    const userPrefs = userData?.preferences || {};

    return {
      last_active_store_id: prefData?.last_active_store_id || null,
      last_active_publication_id: prefData?.last_active_publication_id || null,
      ...userPrefs,
      timezone: userPrefs.timezone || defaults.timezone,
      currency: userPrefs.currency || defaults.currency,
      locale: userPrefs.locale || defaults.locale,
      theme: this.getThemePreference(userPrefs.theme, defaults.theme),
      onboarding_completed:
        userPrefs.onboarding_completed ?? defaults.onboarding_completed,
    };
  }

  /**
   * Update user preferences
   */
  async updateUserPreferences(
    userId: string,
    updates: {
      last_active_store_id?: string | null;
      last_active_publication_id?: string | null;
      timezone?: string;
      currency?: string;
      locale?: string;
      theme?: ThemePreference;
      onboarding_intent?: string;
      onboarding_interests?: string[];
      onboarding_role?: "consumer" | "creator";
      onboarding_completed?: boolean;
    },
  ): Promise<void> {
    // Update last_active fields in user_preferences table
    const {
      last_active_store_id,
      last_active_publication_id,
      ...generalPrefs
    } = updates;

    if (
      last_active_store_id !== undefined ||
      last_active_publication_id !== undefined
    ) {
      const prefUpdates: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };
      if (last_active_store_id !== undefined)
        prefUpdates.last_active_store_id = last_active_store_id;
      if (last_active_publication_id !== undefined)
        prefUpdates.last_active_publication_id = last_active_publication_id;

      const { error } = await this.supabase.from("user_preferences").upsert(
        {
          user_id: userId,
          ...prefUpdates,
        },
        { onConflict: "user_id" },
      );

      if (error) throw error;
    }

    // Update general preferences (timezone, currency, locale, theme) in users.preferences
    if (Object.keys(generalPrefs).length > 0) {
      // Fetch existing preferences first
      const { data: existing, error: fetchError } = await this.supabase
        .from("users")
        .select("preferences")
        .eq("id", userId)
        .single();

      if (fetchError) throw fetchError;

      const merged = {
        ...(existing?.preferences || {}),
        ...generalPrefs,
      };
      console.log(
        `[UserService] Attempting to update preferences for user: ${userId}`,
        merged,
      );

      const { data: updatedData, error: updateError } = await this.supabase
        .from("users")
        .update({ preferences: merged })
        .eq("id", userId)
        .select();

      if (updateError) {
        console.error(`[UserService] DB Update Error:`, updateError);
        throw updateError;
      }

      if (!updatedData || updatedData.length === 0) {
        console.error(
          `[UserService] CRITICAL: No rows matched during update for user ${userId}. This usually means RLS policies are blocking the UPDATE operation even though authentication succeeded.`,
        );
        throw new Error(
          "Failed to update preferences: Record not found or RLS policy violation.",
        );
      }

      console.log(
        `[UserService] Successfully updated preferences in DB for user: ${userId}`,
      );
    }
  }

  private getThemePreference(
    value: unknown,
    fallback: ThemePreference,
  ): ThemePreference {
    return value === "light" || value === "dark" || value === "system"
      ? value
      : fallback;
  }

  /**
   * Update user profile details
   */
  async updateProfile(
    userId: string,
    updates: {
      first_name?: string;
      last_name?: string;
      bio?: string;
      username?: string;
      website?: string;
      name?: string;
      location?: string;
      phone_number?: string;
      gender?: string;
    },
  ): Promise<any> {
    const { data, error } = await this.supabase
      .from("users")
      .update(updates)
      .eq("id", userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Upload user avatar or banner
   */
  async uploadUserFile(
    userId: string,
    file: Express.Multer.File,
    type: "avatar" | "banner",
  ): Promise<string> {
    const timestamp = Date.now();
    const extension = file.originalname.split(".").pop();
    const storagePath = `profiles/${userId}/${type}_${timestamp}.${extension}`;

    const result = await this.storageService.uploadFile(
      "profiles",
      storagePath,
      file,
      true,
    );

    // Update user record
    const updateField = "avatar_url";
    const { error: dbError } = await this.supabase
      .from("users")
      .update({ [updateField]: result.url })
      .eq("id", userId);

    if (dbError) throw dbError;

    return result.url;
  }

  /**
   * Get the user's last active store, or their first store if none set
   */
  async getLastActiveStoreId(userId: string): Promise<string | null> {
    // First, check preferences
    const prefs = await this.getUserPreferences(userId);
    if (prefs.last_active_store_id) {
      return prefs.last_active_store_id;
    }

    // Fallback: get first store created by user
    const { data } = await this.supabase
      .from("stores")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    return data?.id || null;
  }

  /**
   * Get aggregated profile data for a user
   * Fetches notes, posts, events, publication, store, and products count
   */
  async getUserProfile(targetUserId: string): Promise<{
    notes: Array<Record<string, unknown>>;
    notesCount: number;
    posts: Array<Record<string, unknown>>;
    postsCount: number;
    events: Array<Record<string, unknown>>;
    eventsCount: number;
    publication: Record<string, unknown> | null;
    store: { slug: string } | null;
    productsCount: number;
    user?: any;
  }> {
    // Verify user exists
    const { data: userData, error: userError } = await this.supabase
      .from("users")
      .select(
        "id, name, username, bio, avatar_url, website, location, account_type, created_at",
      )
      .eq("id", targetUserId)
      .single();

    if (userError || !userData) {
      const error = new Error("User not found") as Error & {
        statusCode?: number;
      };
      error.statusCode = 404;
      throw error;
    }

    // Fetch notes (public, non-replies) - limit to 5 for performance
    const {
      data: notes,
      error: notesError,
      count: notesCount,
    } = await this.supabase
      .from("notes")
      .select(
        "*, users(id, name, username, bio, avatar_url, website), event(*)",
        { count: "exact" },
      )
      .eq("user_id", targetUserId)
      .eq("is_private", false)
      .is("parent_id", null)
      .order("created_at", { ascending: false })
      .limit(5);

    if (notesError) throw notesError;

    // Fetch posts (published) - limit to 5 for performance
    const {
      data: posts,
      error: postsError,
      count: postsCount,
    } = await this.supabase
      .from("posts")
      .select(
        "*, user_id(id, name, username, bio, avatar_url, website), publication(name)",
        { count: "exact" },
      )
      .eq("user_id", targetUserId)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(5);

    if (postsError) throw postsError;

    // Fetch events - limit to 5 for performance
    const {
      data: events,
      error: eventsError,
      count: eventsCount,
    } = await this.supabase
      .from("events")
      .select("*", { count: "exact" })
      .eq("owner_id", targetUserId)
      .order("created_at", { ascending: false })
      .limit(5);

    if (eventsError) throw eventsError;

    // Fetch publication (single)
    const { data: publicationData, error: pubError } = await this.supabase
      .from("publications")
      .select("*, user_id(id, name, username, bio, avatar_url, website)")
      .eq("user_id", targetUserId)
      .limit(1)
      .single();

    let publication: Record<string, unknown> | null = null;

    if (publicationData && !pubError) {
      // Fetch subscribers count
      const { count: subscribersCount } = await this.supabase
        .from("subscriptions")
        .select("*", { count: "exact", head: true })
        .eq("publication_id", publicationData.id);

      publication = {
        ...publicationData,
        subscribers_count: subscribersCount || 0,
      };
    }

    // Fetch store (single, only slug)
    const { data: storeData, error: storeError } = await this.supabase
      .from("stores")
      .select("slug")
      .eq("user_id", targetUserId)
      .limit(1)
      .single();

    const store = storeData && !storeError ? { slug: storeData.slug } : null;

    // Fetch products count
    const { count: productsCount } = await this.supabase
      .from("products")
      .select("*", { count: "exact", head: true })
      .eq("user_id", targetUserId);

    return {
      user: userData,
      notes: notes || [],
      notesCount: notesCount || 0,
      posts: posts || [],
      postsCount: postsCount || 0,
      events: events || [],
      eventsCount: eventsCount || 0,
      publication,
      store,
      productsCount: productsCount || 0,
    };
  }

  /**
   * Get public activity for a user — events attended, subscriptions, purchases.
   * Queried by user.email (issued_tickets) and user.id (subscriptions, orders).
   */
  async getUserActivity(
    userId: string,
    userEmail: string,
  ): Promise<{
    events_attended: any[];
    subscriptions: any[];
    purchases: any[];
  }> {
    // Events attended — issued_tickets with FK join to events table
    const { data: ticketRows, error: ticketError } = await this.supabase
      .from("issued_tickets")
      .select(
        "event_id, created_at, events!event_id(event_name, event_url, start_date, start_time, cover_image, venue, is_physical, is_online)",
      )
      .eq("customer_email", userEmail)
      .order("created_at", { ascending: false })
      .limit(12);

    if (ticketError) {
      console.error(
        "[UserService] getUserActivity - tickets error:",
        ticketError.message,
      );
    }

    const eventsAttended = (ticketRows || [])
      .map((t: any) => t.events)
      .filter(Boolean)
      .filter(
        (e: any, idx: number, arr: any[]) =>
          arr.findIndex((x: any) => x.event_url === e.event_url) === idx,
      );

    // Publication subscriptions — table is "subscriptions", not "publication_subscribers"
    const { data: subRows, error: subError } = await this.supabase
      .from("subscriptions")
      .select("publication:publication_id(name, slug, id, profile_image)")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(20);

    if (subError) {
      console.error(
        "[UserService] getUserActivity - subscriptions error:",
        subError.message,
      );
    }

    const subscriptions = (subRows || [])
      .map((s: any) => s.publication)
      .filter(Boolean);

    // Store purchases — store_orders filtered by customer_email (no customer_id column)
    // items are stored as JSONB on the order itself
    const { data: orderRows, error: orderError } = await this.supabase
      .from("store_orders")
      .select("id, total, created_at, items, store:store_id(slug, name)")
      .eq("customer_email", userEmail)
      .order("created_at", { ascending: false })
      .limit(12);

    if (orderError) {
      console.error(
        "[UserService] getUserActivity - orders error:",
        orderError.message,
      );
    }

    // Flatten order items from JSONB into a flat list of purchases
    const purchases = (orderRows || [])
      .flatMap((o: any) => {
        const store = o.store;
        const items: any[] = Array.isArray(o.items) ? o.items : [];
        return items.map((item: any) => ({
          product_name: item.name || item.product_name || "Product",
          amount: item.price || item.amount || 0,
          store_slug: store?.slug ?? null,
          store_name: store?.name ?? null,
        }));
      })
      .slice(0, 12);

    return { events_attended: eventsAttended, subscriptions, purchases };
  }

  /**
   * Get user profile by username
   */
  async getUserProfileByUsername(username: string): Promise<any> {
    try {
      console.log("username", username);
      const { data: user, error } = await this.supabase
        .from("users")
        .select(
          "id, name, username, bio, avatar_url, website, location, account_type, created_at",
        )
        .eq("username", username)
        .single();

      console.log("user", user);
      if (error || !user) {
        console.log("Error:", error);
        const err = new Error("User not found") as any;
        err.statusCode = 404;
        throw err;
      }

      const profileData = await this.getUserProfile(user.id);

      return {
        user,
        ...profileData,
      };
    } catch (error) {
      console.error("Error in getUserProfileByUsername:", error);
      throw error;
    }
  }
}
