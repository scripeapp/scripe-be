import "dotenv/config";
import { Response } from "express";
import { supabase } from "../config/supabase";
import { SupabaseRequest } from "src/types/http";
import ApiResponse from "../utils/apiResponse";

export const changeTippingState = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!; // Use the authenticated client

  try {
    console.log("HEYY 444", req.body.enabled);

    if (req.body.enabled) {
      // Verify requirements
      const { data: postCountData, error: pError } = await supabaseClient.rpc(
        "get_counts",
        {
          user_id: req.user_id,
        },
      );

      if (postCountData && postCountData.length) {
        if (
          postCountData[0].publications_count == 0 ||
          postCountData[0].posts_count < 5
        ) {
          throw new Error(
            "User doesn't satisfy post or publication count requirement!",
          );
        }
      } else {
        throw new Error(
          "User doesn't satisfy post or publication count requirement!",
        );
      }

      // Require at least one owned business with a configured subaccount
      const { data: businessSubaccount } = await supabaseClient
        .from("businesses")
        .select("id")
        .eq("owner_user_id", req.user_id)
        .not("paystack_subaccount_code", "is", null)
        .limit(1)
        .single();

      if (!businessSubaccount) {
        throw new Error(
          "Please configure a payment account in Business Settings before enabling tipping.",
        );
      }
    }

    const { data, error } = await supabaseClient
      .from("users")
      .update({
        tipping_enabled: req.body.enabled,
      })
      .eq("id", req.user_id)
      .select()
      .single();

    console.log(data, error);

    if (error) {
      throw new Error(error.message);
    }

    return res.status(200).json({
      success: true,
      message: "Tipping status updated successfully",
      data,
    });
  } catch (error: any) {
    console.error("Error changing tipping state:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to change tipping state",
      data: error.message,
    });
  }
};

/**
 * Update marketplace visibility setting
 * Controls whether user's content appears in public marketplace feeds
 */
export const updateMarketplaceVisibility = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    const { marketplace_visibility } = req.body;
    let { business_id } = req.body;

    // Validate input
    if (typeof marketplace_visibility !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Invalid request: marketplace_visibility must be a boolean",
      });
    }

    // If business_id is not provided, try to find the user's primary business
    if (!business_id) {
      const { data: ownedBusiness, error: fetchError } = await supabaseClient
        .from("businesses")
        .select("id")
        .eq("owner_user_id", req.user_id)
        .limit(1)
        .single();

      if (fetchError || !ownedBusiness) {
        // Fallback: check if they are a member of any business?
        // Use the helper query from BusinessController if needed,
        // but strictly, only owners should probably be toggling this.
        console.warn(
          "[Settings] No owned business found for user toggling visibility",
        );
        return res.status(400).json({
          success: false,
          message:
            "No business found for this user. Please provide business_id.",
        });
      }

      business_id = ownedBusiness.id;
    }

    // Update business-level visibility
    // This affects Events, Publications, Products, Halqahs, and everything linked to this business
    const { data: businessData, error: bizError } = await supabaseClient
      .from("businesses")
      .update({
        marketplace_visibility,
      })
      .eq("id", business_id)
      .select("id, marketplace_visibility")
      .single();

    if (bizError) {
      console.error("[SettingsController] Business update error:", bizError);
      throw new Error(bizError.message);
    }

    return res.status(200).json({
      success: true,
      data: {
        business: businessData,
      },
    });
  } catch (error: any) {
    console.error("Error updating marketplace visibility:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update marketplace visibility",
      error: error.message,
    });
  }
};

// ============================================================================
// Tipping Requirements
// ============================================================================

/**
 * GET /api/settings/tipping-requirements
 * Returns the three eligibility checks for enabling tipping on the current user's account.
 */
export const getTippingRequirements = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    const { data: counts } = await supabaseClient.rpc("get_counts", {
      user_id: req.user_id,
    });

    const row = counts?.[0] ?? {};

    const { data: biz } = await supabaseClient
      .from("businesses")
      .select("id")
      .eq("owner_user_id", req.user_id)
      .not("paystack_subaccount_code", "is", null)
      .limit(1)
      .single();

    return ApiResponse.success(res, "Tipping requirements fetched", {
      publications_count: row.publications_count ?? 0,
      posts_count: row.posts_count ?? 0,
      has_business_subaccount: !!biz,
    });
  } catch (error: any) {
    return ApiResponse.error(res, error.message || "Failed to fetch tipping requirements");
  }
};

// ============================================================================
// Notification Preferences
// ============================================================================

const DEFAULT_NOTIFICATION_PREFERENCES = {
  email_new_subscriber: true,
  email_new_order: true,
  email_order_update: true,
  email_new_comment: true,
  email_marketing: false,
  email_product_updates: true,
};

/**
 * GET /api/settings/notifications
 * Returns the user's notification preferences
 */
export const getNotificationPreferences = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    const { data, error } = await supabaseClient
      .from("users")
      .select("notification_preferences")
      .eq("id", req.user_id)
      .single();

    if (error) throw error;

    // Merge with defaults in case of missing keys
    const preferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(data?.notification_preferences || {}),
    };

    return res.status(200).json({
      success: true,
      data: preferences,
    });
  } catch (error: any) {
    console.error("Error fetching notification preferences:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notification preferences",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/settings/notifications
 * Updates specific notification preferences (partial update)
 */
export const updateNotificationPreferences = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    // First get existing preferences
    const { data: existing, error: fetchError } = await supabaseClient
      .from("users")
      .select("notification_preferences")
      .eq("id", req.user_id)
      .single();

    if (fetchError) throw fetchError;

    // Merge incoming with existing
    const merged = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(existing?.notification_preferences || {}),
      ...req.body,
    };

    const { data, error } = await supabaseClient
      .from("users")
      .update({ notification_preferences: merged })
      .eq("id", req.user_id)
      .select("notification_preferences")
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Notification preferences updated",
      data: data.notification_preferences,
    });
  } catch (error: any) {
    console.error("Error updating notification preferences:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update notification preferences",
      error: error.message,
    });
  }
};

// ============================================================================
// Security Settings (Future-Ready)
// ============================================================================

/**
 * GET /api/settings/security
 * Returns security overview (2FA status, sessions, etc.)
 */
export const getSecuritySettings = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    const { data: user, error } = await supabaseClient
      .from("users")
      .select("email_verified, created_at, updated_at")
      .eq("id", req.user_id)
      .single();

    if (error) throw error;

    // Note: Active sessions tracking would require additional infrastructure
    // This is a placeholder for future implementation
    return res.status(200).json({
      success: true,
      data: {
        two_factor_enabled: false, // Placeholder - needs Supabase MFA setup
        email_verified: user?.email_verified ?? false,
        last_password_change: user?.updated_at || null,
        active_sessions: [], // Placeholder - needs session tracking
      },
    });
  } catch (error: any) {
    console.error("Error fetching security settings:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch security settings",
      error: error.message,
    });
  }
};

/**
 * DELETE /api/settings/security/sessions/:sessionId
 * Revokes a specific session (placeholder)
 */
export const revokeSession = async (req: SupabaseRequest, res: Response) => {
  const { sessionId } = req.params;

  // Note: This requires Supabase session management or custom session tracking
  // Placeholder implementation
  return res.status(200).json({
    success: true,
    message: `Session ${sessionId} revoked`,
  });
};

// ============================================================================
// Wallet/Payout Preferences
// ============================================================================

const DEFAULT_PAYOUT_PREFERENCES = {
  payout_frequency: "automatic",
  minimum_payout: 1000,
  hold_payouts: false,
};

/**
 * GET /api/wallet/preferences
 * Returns payout preferences
 */
export const getPayoutPreferences = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    const { data, error } = await supabaseClient
      .from("users")
      .select("payout_preferences")
      .eq("id", req.user_id)
      .single();

    if (error) throw error;

    const preferences = {
      ...DEFAULT_PAYOUT_PREFERENCES,
      ...(data?.payout_preferences || {}),
    };

    return res.status(200).json({
      success: true,
      data: preferences,
    });
  } catch (error: any) {
    console.error("Error fetching payout preferences:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payout preferences",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/wallet/preferences
 * Updates payout preferences
 */
export const updatePayoutPreferences = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const supabaseClient = req.supabase!;

  try {
    // Validate payout_frequency if provided
    const validFrequencies = ["automatic", "daily", "weekly", "manual"];
    if (
      req.body.payout_frequency &&
      !validFrequencies.includes(req.body.payout_frequency)
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid payout_frequency. Must be one of: ${validFrequencies.join(", ")}`,
      });
    }

    // Validate minimum_payout if provided
    if (req.body.minimum_payout !== undefined && req.body.minimum_payout < 0) {
      return res.status(400).json({
        success: false,
        message: "minimum_payout must be a positive number",
      });
    }

    // Get existing preferences
    const { data: existing, error: fetchError } = await supabaseClient
      .from("users")
      .select("payout_preferences")
      .eq("id", req.user_id)
      .single();

    if (fetchError) throw fetchError;

    const merged = {
      ...DEFAULT_PAYOUT_PREFERENCES,
      ...(existing?.payout_preferences || {}),
      ...req.body,
    };

    const { data, error } = await supabaseClient
      .from("users")
      .update({ payout_preferences: merged })
      .eq("id", req.user_id)
      .select("payout_preferences")
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Payout preferences updated",
      data: data.payout_preferences,
    });
  } catch (error: any) {
    console.error("Error updating payout preferences:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update payout preferences",
      error: error.message,
    });
  }
};
