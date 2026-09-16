/**
 * Subscription Service
 * Handles membership subscriptions with Paystack integration
 */

import { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";

export interface Subscription {
  id: string;
  user_id: string;
  product_id: string;
  store_id: string;
  paystack_subscription_code: string | null;
  paystack_customer_code: string | null;
  status: "active" | "paused" | "cancelled" | "expired" | "pending";
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface MembershipContent {
  id: string;
  product_id: string;
  title: string;
  description: string | null;
  content: Record<string, any>;
  access_tier: string | null;
  position: number;
  created_at: string;
}

export class SubscriptionService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Create a new subscription (called after successful Paystack subscription)
   */
  async createSubscription(data: {
    user_id: string;
    product_id: string;
    store_id: string;
    paystack_subscription_code?: string;
    paystack_customer_code?: string;
    period_start?: string;
    period_end?: string;
  }): Promise<Subscription> {
    const { data: subscription, error } = await this.supabase
      .from("store_subscriptions")
      .insert({
        user_id: data.user_id,
        product_id: data.product_id,
        store_id: data.store_id,
        paystack_subscription_code: data.paystack_subscription_code || null,
        paystack_customer_code: data.paystack_customer_code || null,
        status: data.paystack_subscription_code ? "active" : "pending",
        current_period_start: data.period_start || new Date().toISOString(),
        current_period_end: data.period_end || null,
      })
      .select()
      .single();

    if (error) {
      console.error("[SubscriptionService.createSubscription] Error:", error);
      throw error;
    }

    return subscription as Subscription;
  }

  /**
   * Activate or renew a store membership subscription (usually from webhook)
   */
  async activateSubscription(params: {
    productId: string;
    userId: string;
    paystackSubscriptionCode?: string;
    paystackCustomerCode?: string;
    paystackEmailToken?: string;
    reference: string;
  }): Promise<Subscription> {
    const {
      productId,
      userId,
      paystackSubscriptionCode,
      paystackCustomerCode,
      paystackEmailToken,
      reference,
    } = params;

    // 1. Get product to verify it's a membership and get store_id
    const { data: product, error: productError } = await this.supabase
      .from("products")
      .select("store_id, type")
      .eq("id", productId)
      .single();

    if (productError || !product) {
      throw new Error("Product not found");
    }

    if (product.type !== "membership") {
      throw new Error("Product is not a membership");
    }

    // 2. Calculate dates
    const now = new Date();
    const periodEnd = new Date(now);
    // Hardcoded to monthly — extend when product metadata carries billing interval
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const subscriptionData = {
      user_id: userId,
      product_id: productId,
      store_id: product.store_id,
      paystack_subscription_code: paystackSubscriptionCode || null,
      paystack_customer_code: paystackCustomerCode || null,
      paystack_email_token: paystackEmailToken || null,
      status: "active",
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      updated_at: now.toISOString(),
    };

    // 3. Upsert subscription
    // Check if user already has a subscription for this product
    const { data: existingSub } = await this.supabase
      .from("store_subscriptions")
      .select("id")
      .eq("user_id", userId)
      .eq("product_id", productId)
      .single();

    let result;
    if (existingSub) {
      const { data, error } = await this.supabase
        .from("store_subscriptions")
        .update(subscriptionData)
        .eq("id", existingSub.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await this.supabase
        .from("store_subscriptions")
        .insert({
          id: crypto.randomUUID(),
          ...subscriptionData,
          created_at: now.toISOString(),
        })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    return result as Subscription;
  }

  /**
   * Get user's active subscriptions
   */
  async getUserSubscriptions(userId: string): Promise<Subscription[]> {
    const { data, error } = await this.supabase
      .from("store_subscriptions")
      .select(
        `
        *,
        product:products(id, name, price, membership, cover_image),
        store:stores(id, name, slug)
      `,
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[SubscriptionService.getUserSubscriptions] Error:", error);
      throw error;
    }

    return data as Subscription[];
  }

  /**
   * Get a single subscription
   */
  async getSubscription(
    subscriptionId: string,
    userId: string,
  ): Promise<Subscription> {
    const { data, error } = await this.supabase
      .from("store_subscriptions")
      .select(
        `
        *,
        product:products(id, name, price, membership, cover_image),
        store:stores(id, name, slug)
      `,
      )
      .eq("id", subscriptionId)
      .eq("user_id", userId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Subscription not found"), {
          statusCode: 404,
        });
      }
      throw error;
    }

    return data as Subscription;
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(
    subscriptionId: string,
    userId: string,
  ): Promise<Subscription> {
    // Verify ownership
    const existing = await this.getSubscription(subscriptionId, userId);

    if (existing.status === "cancelled") {
      throw Object.assign(new Error("Subscription already cancelled"), {
        statusCode: 400,
      });
    }

    // TODO: Call Paystack API to cancel subscription
    // await paystackClient.subscription.disable(existing.paystack_subscription_code);

    const { data, error } = await this.supabase
      .from("store_subscriptions")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", subscriptionId)
      .select()
      .single();

    if (error) throw error;
    return data as Subscription;
  }

  /**
   * Pause a subscription (if supported by payment provider)
   */
  async pauseSubscription(
    subscriptionId: string,
    userId: string,
  ): Promise<Subscription> {
    const existing = await this.getSubscription(subscriptionId, userId);

    if (existing.status !== "active") {
      throw Object.assign(
        new Error("Only active subscriptions can be paused"),
        { statusCode: 400 },
      );
    }

    const { data, error } = await this.supabase
      .from("store_subscriptions")
      .update({
        status: "paused",
        updated_at: new Date().toISOString(),
      })
      .eq("id", subscriptionId)
      .select()
      .single();

    if (error) throw error;
    return data as Subscription;
  }

  /**
   * Resume a paused subscription
   */
  async resumeSubscription(
    subscriptionId: string,
    userId: string,
  ): Promise<Subscription> {
    const existing = await this.getSubscription(subscriptionId, userId);

    if (existing.status !== "paused") {
      throw Object.assign(
        new Error("Only paused subscriptions can be resumed"),
        { statusCode: 400 },
      );
    }

    // TODO: Call Paystack API to re-enable subscription

    const { data, error } = await this.supabase
      .from("store_subscriptions")
      .update({
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", subscriptionId)
      .select()
      .single();

    if (error) throw error;
    return data as Subscription;
  }

  /**
   * Update subscription from webhook event
   */
  async updateFromWebhook(
    paystackCode: string,
    updates: {
      status?: Subscription["status"];
      period_start?: string;
      period_end?: string;
    },
  ): Promise<Subscription | null> {
    const { data, error } = await this.supabase
      .from("store_subscriptions")
      .update({
        ...updates,
        current_period_start: updates.period_start,
        current_period_end: updates.period_end,
        updated_at: new Date().toISOString(),
      })
      .eq("paystack_subscription_code", paystackCode)
      .select()
      .maybeSingle();

    if (error) {
      console.error("[SubscriptionService.updateFromWebhook] Error:", error);
      return null;
    }

    if (!data) return null;

    return data as Subscription;
  }

  /**
   * Validate that a user is the merchant (owner) of a product's store
   */
  async validateProductMerchantAccess(
    userId: string,
    productId: string,
  ): Promise<boolean> {
    const { data: product, error } = await this.supabase
      .from("products")
      .select("id, store_id, stores(user_id)")
      .eq("id", productId)
      .single();

    if (error || !product) {
      throw new Error("Product not found");
    }

    const storeInfo = Array.isArray(product.stores)
      ? product.stores[0]
      : (product.stores as any);
    const storeOwnerId = storeInfo?.user_id;
    return userId === storeOwnerId;
  }

  /**
   * Validate that a user is the merchant (owner) of a content item's store
   */
  async validateContentMerchantAccess(
    userId: string,
    contentId: string,
  ): Promise<string> {
    const { data: content, error } = await this.supabase
      .from("membership_content")
      .select("product_id")
      .eq("id", contentId)
      .single();

    if (error || !content) {
      throw new Error("Content item not found");
    }

    const hasAccess = await this.validateProductMerchantAccess(
      userId,
      content.product_id,
    );
    if (!hasAccess) {
      throw Object.assign(
        new Error("Unauthorized: Only the store owner can perform this action"),
        { statusCode: 403 },
      );
    }

    return content.product_id;
  }

  /**
   * Check if user has active subscription to a product
   */
  async hasActiveSubscription(
    userId: string,
    productId: string,
  ): Promise<boolean> {
    const { data } = await this.supabase
      .from("store_subscriptions")
      .select("id")
      .eq("user_id", userId)
      .eq("product_id", productId)
      .eq("status", "active")
      .limit(1);

    return (data?.length || 0) > 0;
  }

  // ============================================================================
  // Membership Content Management
  // ============================================================================

  /**
   * Get membership content for a product (checks subscription access)
   */
  async getMembershipContent(
    productId: string,
    userId?: string,
  ): Promise<MembershipContent[]> {
    // 1. Get product and store owner information
    const { data: product, error: productError } = await this.supabase
      .from("products")
      .select("id, store_id, stores(user_id)")
      .eq("id", productId)
      .single();

    if (productError || !product) {
      throw new Error("Product not found");
    }

    // Handle both object and array (Supabase join can vary)
    const storeInfo = Array.isArray(product.stores)
      ? product.stores[0]
      : (product.stores as any);
    const storeOwnerId = storeInfo?.user_id;
    let hasFullAccess = false;

    // 2. Check for Merchant Access (Owner of the store)
    if (userId && userId === storeOwnerId) {
      hasFullAccess = true;
    }

    // 3. Check for Subscriber Access (if not merchant)
    if (!hasFullAccess && userId) {
      hasFullAccess = await this.hasActiveSubscription(userId, productId);
    }

    // 4. Fetch content
    const { data: contentItems, error: contentError } = await this.supabase
      .from("membership_content")
      .select("*")
      .eq("product_id", productId)
      .order("position", { ascending: true });

    if (contentError) throw contentError;

    // 5. Filter/Sanitize content based on access level
    if (hasFullAccess) {
      return contentItems as MembershipContent[];
    }

    // sanitize for non-subscribers (omit url and text)
    return (contentItems || []).map((item: any) => {
      return {
        ...item,
        content: {
          type: item.content?.type,
        },
      };
    }) as MembershipContent[];
  }

  /**
   * Create membership content
   */
  async createContent(
    productId: string,
    data: {
      title: string;
      description?: string;
      content?: Record<string, any>;
      access_tier?: string;
    },
  ): Promise<MembershipContent> {
    // Get max position
    const { data: existing } = await this.supabase
      .from("membership_content")
      .select("position")
      .eq("product_id", productId)
      .order("position", { ascending: false })
      .limit(1);

    const nextPosition = existing?.[0] ? existing[0].position + 1 : 0;

    const { data: content, error } = await this.supabase
      .from("membership_content")
      .insert({
        product_id: productId,
        title: data.title,
        description: data.description || null,
        content: data.content || {},
        access_tier: data.access_tier || null,
        position: nextPosition,
      })
      .select()
      .single();

    if (error) throw error;
    return content as MembershipContent;
  }

  /**
   * Update membership content
   */
  async updateContent(
    contentId: string,
    data: Partial<MembershipContent>,
  ): Promise<MembershipContent> {
    const { data: content, error } = await this.supabase
      .from("membership_content")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", contentId)
      .select()
      .single();

    if (error) throw error;
    return content as MembershipContent;
  }

  /**
   * Delete membership content
   */
  async deleteContent(contentId: string): Promise<void> {
    const { error } = await this.supabase
      .from("membership_content")
      .delete()
      .eq("id", contentId);

    if (error) throw error;
  }

  /**
   * Get store subscriptions (for merchant dashboard)
   */
  async getStoreSubscriptions(
    storeId: string,
    filters?: { status?: string },
  ): Promise<Subscription[]> {
    let query = this.supabase
      .from("store_subscriptions")
      .select(
        `
        *,
        product:products(id, name, price, membership)
      `,
      )
      .eq("store_id", storeId)
      .order("created_at", { ascending: false });

    if (filters?.status) {
      query = query.eq("status", filters.status);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data as Subscription[];
  }

  /**
   * Get subscribers for a specific product with user details
   */
  async getProductSubscribers(
    productId: string,
    filters?: { status?: string },
  ): Promise<any[]> {
    let query = this.supabase
      .from("store_subscriptions")
      .select(
        `
        id,
        user_id,
        status,
        current_period_start,
        current_period_end,
        cancelled_at,
        created_at,
        users!user_id(name, email, preferences)
      `,
      )
      .eq("product_id", productId)
      .order("created_at", { ascending: false });

    if (filters?.status) {
      query = query.eq("status", filters.status);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Map to include avatar from preferences/metadata if it exists
    return (data || []).map((sub: any) => ({
      id: sub.id,
      user_id: sub.user_id,
      status: sub.status,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      cancelled_at: sub.cancelled_at,
      created_at: sub.created_at,
      user_name: sub.users?.name,
      user_email: sub.users?.email,
      user_avatar:
        sub.users?.preferences?.profile_image ||
        sub.users?.preferences?.avatar_url ||
        null,
    }));
  }
}
