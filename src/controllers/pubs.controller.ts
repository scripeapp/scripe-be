import "dotenv/config";
import { Response } from "express";
import axios from "axios";
import { supabase } from "../config/supabase";
import { SupabaseRequest } from "../types/http";
import { uploadMulterFileToR2 } from "../utils/storage.util";

// Create a new publication
// Domain name not handled yet
export const createPublication = async (
  req: SupabaseRequest,
  res: Response,
) => {
  // const publication = JSON.parse(req.body);
  console.log(req.body.name);

  try {
    const { name, description } = req.body;
    const businessId = (req as any).businessId || req.body.business_id;

    const superbaseClient = req.supabase!;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Newsletter name is required" });
    }

    const { data: pubData, error: insertError } = await superbaseClient
      .from("publications")
      .insert([
        {
          name,
          description,
          user_id: req.user_id,
          business_id: businessId, // Link to business
          domain_name: (req.body.slug || name || "")
            .trim()
            .replace(/\s+/g, "-")
            .toLowerCase(),
          slug: (req.body.slug || name || "")
            .trim()
            .replace(/\s+/g, "-")
            .toLowerCase(),
        },
      ])
      .select("*, user_id(*)")
      .single();

    if (insertError) throw insertError;

    // Create initial subscription for the author
    const newSub = {
      publication_id: pubData.id,
      user_id: req.user_id,
      subscribed_at: new Date(),
      subscription_type: "free",
    };

    await superbaseClient.from("subscriptions").insert([newSub]);

    // Fire-and-forget notification (non-blocking)
    if (process.env.SERVER_URL) {
      axios
        .post(`${process.env.SERVER_URL}/notifications/new-publication`, {
          name: pubData.user_id?.name || "Author",
          email: pubData.user_id?.email,
          pub_id: pubData.id,
        })
        .catch((err) => {
          console.error(
            "Failed to send newsletter notification:",
            err.message,
          );
        });
    }

    return res.status(201).json({
      success: true,
      message: "Newsletter created successfully",
      data: pubData,
    });
  } catch (error: any) {
    console.error("Error creating newsletter:", error);
    return res.status(500).json({
      success: false,
      message: `Failed to create newsletter: ${error.message}`,
      data: error.message,
    });
  }
};

export const deletePublication = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id } = req.params;

  const supabaseClient = req.supabase!; // Use the authenticated client

  try {
    // 1. Delete associated posts first (to avoid FK constraints)
    await supabaseClient.from("posts").delete().eq("publication", id);

    // 2. Delete associated subscriptions
    await supabaseClient
      .from("subscriptions")
      .delete()
      .eq("publication_id", id);

    // 3. Delete the publication
    const { error, count } = await supabaseClient
      .from("publications")
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) {
      throw new Error(error.message);
    }

    if (count === 0) {
      return res.status(404).json({
        success: false,
        message: "Newsletter not found or already deleted",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Newsletter deleted successfully",
    });
  } catch (error: any) {
    console.error("Error deleting newsletter:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete newsletter",
      data: error.message,
    });
  }
};

export const getPublicationPosts = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id } = req.params;
  const db = req.supabase;
  const userId = req.user_id;

  try {
    // 1. Fetch all published posts
    const { data: posts, error } = await db
      .from("posts")
      .select("*, user_id(*), publication(*)")
      .eq("publication", id)
      .eq("status", "published")
      .neq("status", "archived") // Double check safety, though eq published usually excludes archived if enum
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    // 2. Get user's subscription status if authenticated
    let subscription: any = null;
    if (userId) {
      const { data: subData } = await db
        .from("subscriptions")
        .select("*")
        .eq("publication_id", id)
        .eq("user_id", userId)
        .single();
      subscription = subData;
    }

    // 3. Process posts: Add access info and sanitize body if needed
    const postsWithMetrics = (posts || []).map((post: any) => {
      let canAccess = true;

      // Check visibility rules
      if (post.visibility && post.visibility !== "public") {
        if (!subscription || subscription.status !== "active") {
          canAccess = false;
        } else if (post.visibility === "paid_subscribers") {
          if (subscription.subscription_type !== "paid") {
            canAccess = false;
          } else if (
            subscription.status === "cancelled" &&
            subscription.current_period_end
          ) {
            // Check if cancelled subscription period has ended
            if (new Date() > new Date(subscription.current_period_end)) {
              canAccess = false;
            }
          }
        }
      }

      // Base metrics
      const basePost = {
        ...post,
        open_rate:
          post.email_sent_count > 0
            ? Math.round((post.email_open_count / post.email_sent_count) * 100)
            : 0,
      };

      if (!canAccess) {
        // Return sanitized/locked version
        return {
          ...basePost,
          body: null, // Sanitize content
          content: null, // Sanitize content (if exists)
          is_locked: true,
          _access: {
            can_access: false,
            visibility: post.visibility,
          },
        };
      }

      // Return full version
      return {
        ...basePost,
        is_locked: false,
        _access: {
          can_access: true,
          visibility: post.visibility || "public",
        },
      };
    });

    return res.status(200).json({
      success: true,
      message: "Publication posts fetched successfully",
      data: postsWithMetrics,
      subscription: subscription
        ? {
            type: subscription.subscription_type,
            status: subscription.status,
            plan: subscription.plan,
          }
        : null,
    });
  } catch (error: any) {
    console.error("Error fetching publication posts:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch publication posts",
      data: error.message,
    });
  }
};

/**
 * GET /publications/mine
 * Returns only publications owned by the authenticated user.
 * No RPC — straight user_id filter.
 */
export const getMyPublications = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const db = req.supabase;
    const businessId = (req as any).businessId || req.query.business_id;

    let query = db
      .from("publications")
      .select("*, subscriptions(count)")
      .eq("user_id", req.user_id!)
      .order("created_at", { ascending: false });

    if (businessId) {
      query = query.eq("business_id", businessId);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    return res.status(200).json({
      success: true,
      message: "Publications fetched successfully",
      data: data ?? [],
    });
  } catch (error: any) {
    console.error("Error fetching user publications:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch publications",
      data: error.message,
    });
  }
};

export const getAllPublications = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    let data, error;
    const businessId = (req as any).businessId || req.query.business_id;
    const db = req.supabase;

    if (req.user_id) {
      let query;
      if (businessId) {
        // Dashboard context: Filter by business_id
        ({ data, error } = await db
          .from("publications")
          .select(
            "*, user_id(name, email, marketplace_visibility), business:business_id(marketplace_visibility), subscriptions(count)",
          )
          .eq("business_id", businessId)
          .order("created_at", { ascending: false }));
      } else {
        // Legacy/User context: Use RPC or user_id filter
        ({ data, error } = await db.rpc(
          "get_publications_with_subscription_status",
          {
            user_id_param: req.user_id,
          },
        ));
      }

      if (data && !businessId) {
        data = data.filter((pub: any) => {
          // 1. If it belongs to a business, check business visibility
          if (pub.business) {
            return pub.business.marketplace_visibility !== false;
          }
          // 2. Fallback to owner visibility for personal pubs (check if user even exists on the object)
          return pub.user_id?.marketplace_visibility !== false;
        });
      }
    } else {
      ({ data, error } = await db
        .from("publications")
        .select(
          "*, user_id(name, email, marketplace_visibility), business:business_id(marketplace_visibility), subscriptions(count)",
        )
        .order("created_at", { ascending: false }));

      if (data) {
        data = data.filter((pub: any) => {
          // 1. If it belongs to a business, check business visibility
          if (pub.business) {
            return pub.business.marketplace_visibility !== false;
          }
          // 2. Fallback to owner visibility
          return pub.user_id?.marketplace_visibility !== false;
        });
      }
    }

    if (error) {
      throw new Error(error.message);
    }

    return res.status(200).json({
      success: true,
      message: "Publication posts fetched successfully",
      data,
    });
  } catch (error: any) {
    console.error("Error fetching publications:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch publications",
      data: error.message,
    });
  }
};

export const updatePublication = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const { id } = req.params;
    const publication = JSON.parse(req.body.publication);
    const imageFile = req.file;

    const supabaseClient = req.supabase!; // Use the authenticated client

    // Extract only the fields we want to update to avoid "column does not exist" errors
    // or accidentally overwriting restricted fields
    const allowedFields = [
      "name",
      "description",
      "profile_image",
      "category",
      "subcategory",
      "tags",
      "monetization",
      "domain_name",
      "slug",
    ];

    const updatePayload: any = {};
    allowedFields.forEach((field) => {
      if (publication[field] !== undefined) {
        updatePayload[field] = publication[field];
      }
    });

    if (imageFile) {
      const key = `publications/${publication.id}/profile_image`;
      updatePayload.profile_image = await uploadMulterFileToR2(imageFile as Express.Multer.File, key);
    }

    const { data: pubData, error } = await supabaseClient
      .from("publications")
      .update({
        ...updatePayload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Publication updated successfully",
      data: pubData,
    });
  } catch (err: any) {
    console.error("Error updating publication:", err);
    return res.status(500).json({
      error: "Failed to update publication",
      details: err.message,
    });
  }
};

export const getPublicationDetail = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id } = req.params;
  const supabaseClient = req.supabase!;

  try {
    // 1. Get publication info
    const { data: publication, error: pubError } = await supabaseClient
      .from("publications")
      .select("*, user_id(*)")
      .eq("id", id)
      .single();

    if (pubError) throw pubError;

    // 2. Get subscriber count (unless skipped for performance)
    const skipAnalytics = req.query.skip_analytics === "true";

    let analytics = {
      subscribers: 0,
      published_posts: 0,
      draft_posts: 0,
      scheduled_posts: 0,
      posts: 0,
    };

    if (!skipAnalytics) {
      // Run count queries in parallel
      const [
        { count: subscriberCount, error: subError },
        { count: publishedCount, error: publishedError },
        { count: draftCount, error: draftError },
        { count: scheduledCount, error: scheduledError },
      ] = await Promise.all([
        supabaseClient
          .from("subscriptions")
          .select("*", { count: "exact", head: true })
          .eq("publication_id", id),
        supabaseClient
          .from("posts")
          .select("*", { count: "exact", head: true })
          .eq("publication", id)
          .eq("status", "published"),
        supabaseClient
          .from("posts")
          .select("*", { count: "exact", head: true })
          .eq("publication", id)
          .eq("status", "draft"),
        supabaseClient
          .from("posts")
          .select("*", { count: "exact", head: true })
          .eq("publication", id)
          .eq("status", "scheduled"),
      ]);

      if (subError) throw subError;
      if (publishedError) throw publishedError;
      if (draftError) throw draftError;
      if (scheduledError) throw scheduledError;

      analytics = {
        subscribers: subscriberCount || 0,
        published_posts: publishedCount || 0,
        draft_posts: draftCount || 0,
        scheduled_posts: scheduledCount || 0,
        posts:
          (publishedCount || 0) + (draftCount || 0) + (scheduledCount || 0),
      };
    }

    return res.status(200).json({
      success: true,
      message: "Publication details fetched successfully",
      data: {
        ...publication,
        analytics,
      },
    });
  } catch (error: any) {
    console.error("Error fetching publication details:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch publication details",
      data: error.message,
    });
  }
};

export const incrementPostViews = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id } = req.params;
  const db = req.supabase;

  try {
    const { error } = await db.rpc("increment_post_views", {
      post_id_param: id,
    });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Post view count incremented",
    });
  } catch (error: any) {
    console.error("Error incrementing post views:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to increment post view count",
      data: error.message,
    });
  }
};

// ============================================================================
// PAID SUBSCRIPTIONS
// ============================================================================

import { publicationSubscriptionService } from "../services/publication-subscription.service";

/**
 * Update publication monetization settings
 * PATCH /api/publications/:id/monetization
 * @access Publication owner only
 */
export const updateMonetization = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id } = req.params;
  const { enabled, monthly_price, yearly_price, fee_bearer } = req.body;
  const supabaseClient = req.supabase!;

  try {
    // Verify ownership
    const { data: publication, error: fetchError } = await supabaseClient
      .from("publications")
      .select("id, user_id, business_id")
      .eq("id", id)
      .single();

    if (fetchError || !publication) {
      return res.status(404).json({
        success: false,
        message: "Publication not found",
      });
    }

    // Check if user is the owner
    const isOwner = publication.user_id === req.user_id;

    // If not owner, checking if they have business permission
    let hasBusinessPermission = false;
    if (!isOwner && publication.business_id) {
      // Import PermissionService dynamically to avoid circular dependency issues if any
      const { PermissionService } = require("../services/permission.service");
      const permissionService = new PermissionService(supabaseClient);
      hasBusinessPermission = await permissionService.hasPermission(
        req.user_id!,
        publication.business_id,
        "publication.post.update",
      );
    }

    if (!isOwner && !hasBusinessPermission) {
      return res.status(403).json({
        success: false,
        message: "Access denied: You do not own this publication",
      });
    }

    // Validate prices (must be in kobo, > 0)
    if (enabled) {
      if (!monthly_price || monthly_price <= 0) {
        return res.status(400).json({
          success: false,
          message:
            "Monthly price is required and must be greater than 0 (in kobo)",
        });
      }
      if (!yearly_price || yearly_price <= 0) {
        return res.status(400).json({
          success: false,
          message:
            "Yearly price is required and must be greater than 0 (in kobo)",
        });
      }
    }

    const monetization = enabled
      ? {
          enabled: true,
          monthly_price: Math.round(monthly_price),
          yearly_price: Math.round(yearly_price),
          currency: "NGN",
          fee_bearer: fee_bearer || "subaccount",
        }
      : null;

    const { data, error } = await supabaseClient
      .from("publications")
      .update({ monetization })
      .eq("id", id)
      .select("id, name, monetization")
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: enabled ? "Monetization enabled" : "Monetization disabled",
      monetization: data.monetization,
    });
  } catch (error: any) {
    console.error("Error updating monetization:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update monetization settings",
      data: error.message,
    });
  }
};

/**
 * Subscribe to a publication
 * POST /api/publications/:id/subscribe
 * @access Authenticated user (not owner)
 */
export const subscribeToPublication = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id: publicationId } = req.params;
  const { plan, currency = "NGN" } = req.body;
  const userId = req.user_id!;
  const supabaseClient = req.supabase!;

  try {
    // Validate plan
    if (!plan || !["free", "monthly", "yearly"].includes(plan)) {
      return res.status(400).json({
        success: false,
        message: "Invalid plan. Must be 'free', 'monthly', or 'yearly'",
      });
    }

    const result = await publicationSubscriptionService.subscribe(
      supabaseClient,
      userId,
      publicationId,
      plan,
      currency,
    );

    return res.status(200).json({
      success: true,
      message: result.payment_url ? "Payment required" : "Subscription created",
      subscription: result.subscription,
      payment_url: result.payment_url,
      payment_reference: result.payment_reference,
    });
  } catch (error: any) {
    console.error("Error subscribing to publication:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to subscribe",
    });
  }
};

/**
 * Get user's subscription to a publication
 * GET /api/publications/:id/subscription
 * @access Authenticated user
 */
export const getPublicationSubscription = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id: publicationId } = req.params;
  const userId = req.user_id!;
  const supabaseClient = req.supabase!;

  try {
    const subscription = await publicationSubscriptionService.getSubscription(
      supabaseClient,
      userId,
      publicationId,
    );

    return res.status(200).json({
      success: true,
      subscription,
    });
  } catch (error: any) {
    console.error("Error fetching subscription:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch subscription",
      data: error.message,
    });
  }
};

/**
 * Cancel a subscription
 * POST /api/subscriptions/:id/cancel
 * @access Subscription owner
 */
export const cancelSubscription = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id: subscriptionId } = req.params;
  const userId = req.user_id!;
  const supabaseClient = req.supabase!;

  try {
    const result = await publicationSubscriptionService.cancelSubscription(
      supabaseClient,
      subscriptionId,
      userId,
    );

    return res.status(200).json({
      success: true,
      message: "Subscription cancelled",
      cancelled_at: result.cancelled_at,
      access_until: result.access_until,
    });
  } catch (error: any) {
    console.error("Error cancelling subscription:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to cancel subscription",
    });
  }
};

/**
 * Get all subscriptions for the current user
 * GET /api/me/subscriptions
 * @access Authenticated user
 */
export const getUserSubscriptions = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const userId = req.user_id!;
  const supabaseClient = req.supabase!;

  try {
    const subscriptions =
      await publicationSubscriptionService.getUserSubscriptions(
        supabaseClient,
        userId,
      );

    return res.status(200).json({
      success: true,
      subscriptions,
    });
  } catch (error: any) {
    console.error("Error fetching user subscriptions:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch subscriptions",
      data: error.message,
    });
  }
};
