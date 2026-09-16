import { Response } from "express";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";
import { UserService } from "../services/user.service";
import { authService } from "../services/auth.service";
import { ActivationGuideService } from "../services/activation-guide.service";
import { ndprService, NDPRRequestType } from "../services/ndpr.service";

/**
 * User Controller
 * Handles user preferences and profile-related operations
 */
class UserController {
  async getActivationGuide(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const userId = req.user_id;
      const businessId = String(req.query.business_id || "").trim();

      if (!userId) {
        return ApiResponse.unauthorized(res, "Unauthorized");
      }

      if (!businessId) {
        return ApiResponse.badRequest(res, "business_id is required");
      }

      const activationGuideService = new ActivationGuideService(req.supabase!);
      const guide = await activationGuideService.getGuideForUser(
        userId,
        businessId,
      );

      return ApiResponse.success(
        res,
        "Activation guide retrieved successfully",
        guide,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_ACTIVATION_GUIDE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get user preferences
   * GET /api/user/preferences
   */
  async getUserPreferences(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const userService = new UserService(req.supabase!);
      const preferences = await userService.getUserPreferences(req.user_id!);

      return ApiResponse.success(
        res,
        "Preferences retrieved successfully",
        preferences,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PREFERENCES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update user preferences
   * PATCH /api/user/preferences
   */
  async updateUserPreferences(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const updates: any = {};
      const fields = [
        "last_active_store_id",
        "last_active_publication_id",
        "timezone",
        "currency",
        "locale",
        "theme",
        "tipping_enabled",
        "notifications",
        "onboarding_intent",
        "onboarding_interests",
        "onboarding_role",
        "onboarding_completed",
      ];

      fields.forEach((field) => {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      });

      const userService = new UserService(req.supabase!);
      console.log(
        `[UserController] Updating preferences for user: ${req.user_id!}`,
        updates,
      );
      await userService.updateUserPreferences(req.user_id!, updates);
      console.log(
        `[UserController] Preferences updated successfully for user: ${req.user_id!}`,
      );

      return ApiResponse.success(res, "Preferences updated successfully", null);
    } catch (err: any) {
      console.error(
        `[UserController] Failed to update preferences for user: ${req.user_id!}`,
        err,
      );
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_PREFERENCES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get user profile data
   * GET /api/user/profile/:userId
   */
  async getUserProfile(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { userId } = req.params;
      const userService = new UserService(req.supabase!);
      const profile = await userService.getUserProfile(userId);

      return ApiResponse.success(
        res,
        "Profile retrieved successfully",
        profile,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      if (status === 404) {
        return ApiResponse.notFound(res, err.message);
      }
      return res.status(status).json({
        success: false,
        error: "GET_PROFILE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update user profile
   * PATCH /api/user/profile
   */
  async updateProfile(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const {
        first_name,
        last_name,
        bio,
        username,
        website,
        name,
        location,
        phone_number,
        gender,
      } = req.body;
      const userService = new UserService(req.supabase!);
      const updatedProfile = await userService.updateProfile(req.user_id!, {
        first_name,
        last_name,
        bio,
        username,
        website,
        name,
        location,
        phone_number,
        gender,
      });

      return ApiResponse.success(
        res,
        "Profile updated successfully",
        updatedProfile,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_PROFILE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update authenticated user's email
   * PATCH /api/user/email
   */
  async updateEmail(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const userId = req.user_id;
      const { email } = req.body as { email?: string };

      if (!userId) {
        return ApiResponse.unauthorized(res, "Unauthorized");
      }

      if (!email || typeof email !== "string") {
        return ApiResponse.badRequest(res, "Valid email is required");
      }

      const normalizedEmail = email.trim().toLowerCase();
      const accessToken =
        req.access_token ||
        (req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.split(" ")[1]
          : "");

      const { data: currentProfile, error: currentProfileError } =
        await req.supabase
          .from("users")
          .select("email")
          .eq("id", userId)
          .single();
      if (currentProfileError) {
        return res.status(400).json({
          success: false,
          error: "UPDATE_EMAIL_ERROR",
          message: "Could not read your profile before updating email.",
          details: currentProfileError.message,
        });
      }

      const currentProfileEmail = (currentProfile?.email || "").toLowerCase();
      if (currentProfileEmail === normalizedEmail) {
        return ApiResponse.success(res, "Email is already up to date.", {
          status: "unchanged",
          current_email: currentProfileEmail,
          pending_email: null,
        });
      }

      const { data: conflict, error: conflictError } = await req.supabase
        .from("users")
        .select("id")
        .eq("email", normalizedEmail)
        .neq("id", userId)
        .limit(1);
      if (conflictError) {
        return res.status(500).json({
          success: false,
          error: "UPDATE_EMAIL_ERROR",
          message: "Could not validate email availability.",
          details: conflictError.message,
        });
      }
      if (conflict && conflict.length > 0) {
        return res.status(409).json({
          success: false,
          error: "UPDATE_EMAIL_ERROR",
          message: "This email is already in use by another account.",
        });
      }

      const authEmailResult = await authService.updateEmailWithAccessToken(
        accessToken,
        normalizedEmail,
      );
      const authEmail = authEmailResult.auth_email;
      const pendingEmail = authEmailResult.pending_email;

      // Sync profile email from auth source-of-truth when immediately updated.
      if (authEmail && authEmail !== currentProfileEmail) {
        await req.supabase
          .from("users")
          .update({ email: authEmail })
          .eq("id", userId);
      }

      const isPending = authEmailResult.status === "pending_confirmation";

      if (isPending) {
        return res.status(200).json({
          success: true,
          message:
            "Confirmation required. We sent an email-change link. Keep using your current email until you confirm.",
          data: {
            status: "pending_confirmation",
            current_email: authEmail || currentProfileEmail,
            pending_email: pendingEmail,
          },
        });
      }

      return res.status(200).json({
        success: true,
        message: "Email updated successfully.",
        data: {
          status: "updated",
          current_email: authEmail || normalizedEmail,
          pending_email: null,
        },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_EMAIL_ERROR",
        message: err.message,
        ...(err?.details ? { details: err.details } : {}),
      });
    }
  }

  /**
   * Update authenticated user's password
   * PATCH /api/user/password
   */
  async updatePassword(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const userId = req.user_id;
      const { oldPassword, newPassword } = req.body as {
        oldPassword?: string;
        newPassword?: string;
      };

      if (!userId) {
        return ApiResponse.unauthorized(res, "Unauthorized");
      }

      if (!oldPassword || !newPassword) {
        return ApiResponse.badRequest(
          res,
          "Old password and new password are required",
        );
      }

      await authService.updatePasswordDirect(userId, oldPassword, newPassword);
      return ApiResponse.success(res, "Password updated successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_PASSWORD_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Upload profile avatar
   * POST /api/user/profile/avatar
   */
  async uploadAvatar(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        return ApiResponse.badRequest(res, "No file provided");
      }

      const userService = new UserService(req.supabase!);
      const avatarUrl = await userService.uploadUserFile(
        req.user_id!,
        file as any,
        "avatar",
      );

      return ApiResponse.success(res, "Avatar uploaded successfully", {
        avatarUrl,
      });
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * Upload profile banner
   * POST /api/user/profile/banner
   */
  async uploadBanner(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        return ApiResponse.badRequest(res, "No file provided");
      }

      const userService = new UserService(req.supabase!);
      const bannerUrl = await userService.uploadUserFile(
        req.user_id!,
        file as any,
        "banner",
      );

      return ApiResponse.success(res, "Banner uploaded successfully", {
        bannerUrl,
      });
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * Get user profile by username
   * GET /api/user/profile/handle/:username
   */
  async getUserProfileByUsername(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { username } = req.params;
      const userService = new UserService(req.supabase!);
      const profile = await userService.getUserProfileByUsername(username);

      return ApiResponse.success(
        res,
        "Profile retrieved successfully",
        profile,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      if (status === 404) {
        return ApiResponse.notFound(res, err.message);
      }
      return res.status(status).json({
        success: false,
        error: "GET_PROFILE_BY_USERNAME_ERROR",
        message: err.message,
      });
    }
  }
  /**
   * GET /api/users/profile/handle/:username/activity
   * Public — returns consumer activity: events attended, subscriptions, purchases.
   */
  async getUserActivityByUsername(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { username } = req.params;
      const userService = new UserService(req.supabase!);

      // Look up user to get id + email
      const { data: user, error } = await req.supabase!
        .from("users")
        .select("id, email")
        .eq("username", username)
        .single();

      if (error || !user) {
        return ApiResponse.notFound(res, "User not found");
      }

      const activity = await userService.getUserActivity(user.id, user.email);
      return ApiResponse.success(res, "Activity retrieved", activity);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * GET /api/users/profile/:userId/tipping
   * Public — returns tipping status + business subaccount codes for a user.
   * Used by profile headers and post floating bars to decide whether to show
   * the tip button and which subaccount to target.
   */
  async getUserTippingInfo(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { userId } = req.params;
      const supabaseClient = req.supabase!;

      const { data: user, error: userError } = await supabaseClient
        .from("users")
        .select("tipping_enabled")
        .eq("id", userId)
        .single();

      if (userError || !user) {
        return ApiResponse.notFound(res, "User not found");
      }

      if (!user.tipping_enabled) {
        return ApiResponse.success(res, "Tipping info fetched", {
          tipping_enabled: false,
          paystack_subaccount_code: null,
          flw_subaccount_id: null,
        });
      }

      const { data: biz } = await supabaseClient
        .from("businesses")
        .select("paystack_subaccount_code, flw_subaccount_id")
        .eq("owner_user_id", userId)
        .not("paystack_subaccount_code", "is", null)
        .limit(1)
        .single();

      return ApiResponse.success(res, "Tipping info fetched", {
        tipping_enabled: true,
        paystack_subaccount_code: biz?.paystack_subaccount_code ?? null,
        flw_subaccount_id: biz?.flw_subaccount_id ?? null,
      });
    } catch (err: any) {
      return ApiResponse.error(res, err.message || "Failed to fetch tipping info");
    }
  }

  // ============================================================================
  // NDPR — User Data Rights (self-service)
  // ============================================================================

  /**
   * POST /api/user/ndpr/request
   * Authenticated user submits a data rights request (access, deletion, etc.).
   */
  async submitNdprRequest(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const userId = req.user_id;
      if (!userId) return ApiResponse.unauthorized(res, "Unauthorized");

      const { request_type, description } = req.body as {
        request_type: NDPRRequestType;
        description?: string;
      };

      const validTypes: NDPRRequestType[] = [
        "access", "deletion", "portability", "rectification", "objection",
      ];
      if (!validTypes.includes(request_type)) {
        return ApiResponse.badRequest(res, `request_type must be one of: ${validTypes.join(", ")}`);
      }

      const { data: user } = await req.supabase!
        .from("users")
        .select("email")
        .eq("id", userId)
        .single();

      if (!user?.email) return ApiResponse.notFound(res, "User not found");

      const request = await ndprService.createRequest(req.supabase!, {
        user_id: userId,
        request_type,
        requester_email: user.email,
        description,
      });

      return ApiResponse.created(res, "Data request submitted. We will respond within 30 days.", request);
    } catch (err: any) {
      return ApiResponse.error(res, err.message || "Failed to submit data request");
    }
  }

  /**
   * GET /api/user/ndpr/requests
   * Lists the authenticated user's own NDPR requests.
   */
  async listMyNdprRequests(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const userId = req.user_id;
      if (!userId) return ApiResponse.unauthorized(res, "Unauthorized");

      const { data, error } = await req.supabase!
        .from("ndpr_requests")
        .select("id, request_type, status, description, due_date, processed_at, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw new Error(error.message);

      return ApiResponse.success(res, "Data requests fetched", data ?? []);
    } catch (err: any) {
      return ApiResponse.error(res, err.message || "Failed to fetch data requests");
    }
  }
}

export const userController = new UserController();
