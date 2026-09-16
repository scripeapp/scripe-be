import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { SocialService } from "../services/social.service";
import ApiResponse from "../utils/apiResponse";
import { notificationService } from "../services/notification.services";

export class SocialController {
  static async followUser(req: SupabaseRequest, res: Response) {
    try {
      const { userId: followingId } = req.params;
      const followerId = req.user_id!;
      const db = req.supabase!;

      const socialService = new SocialService(db);
      const data = await socialService.followUser(followerId, followingId);

      return ApiResponse.success(res, "User followed successfully", data);
    } catch (error: any) {
      console.error("[SocialController.followUser] Error:", error);
      if (error.message === "Users cannot follow themselves") {
        return ApiResponse.badRequest(res, error.message);
      }
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async unfollowUser(req: SupabaseRequest, res: Response) {
    try {
      const { userId: followingId } = req.params;
      const followerId = req.user_id!;
      const db = req.supabase!;

      const socialService = new SocialService(db);
      await socialService.unfollowUser(followerId, followingId);

      return ApiResponse.success(res, "User unfollowed successfully");
    } catch (error: any) {
      console.error("[SocialController.unfollowUser] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async toggleLike(req: SupabaseRequest, res: Response) {
    try {
      // Backwards/forwards compat:
      // frontend sends { object_id, object_type }, but DB schema is likes(post_id).
      const { object_id, post_id, object_type } = req.body;
      const targetId = object_id || post_id;
      const targetType = object_type || "post";
      const userId = req.user_id!;
      const db = req.supabase!;

      if (!targetId || !targetType) {
        return ApiResponse.badRequest(
          res,
          "object_id (or post_id) and object_type are required",
        );
      }

      const socialService = new SocialService(db);
      const result = await socialService.toggleLike(
        userId,
        targetId,
        targetType,
      );

      const message = result.liked
        ? "Liked successfully"
        : "Unliked successfully";

      if (result.liked && targetType === "post") {
        // Fetch post and author details for notification
        const { data: post } = await db
          .from("posts")
          .select("*, user_id(*)")
          .eq("id", targetId)
          .single();

        const { data: liker } = await db
          .from("users")
          .select("*")
          .eq("id", userId)
          .single();

        if (post && liker && post.user_id.id !== userId) {
          notificationService
            .sendNewLikeNotification(post, liker)
            .catch((err) =>
              console.error(
                "[SocialController.toggleLike] Notification error:",
                err,
              ),
            );
        }
      }

      // Always return the resulting like state so the frontend can update deterministically.
      return ApiResponse.success(res, message, {
        liked: result.liked,
        like: result.data || null,
      });
    } catch (error: any) {
      console.error("[SocialController.toggleLike] Error:", error);
      if (error?.message?.includes("posts and comments only")) {
        return ApiResponse.badRequest(res, error.message);
      }
      return ApiResponse.serverError(res, error.message);
    }
  }
}
