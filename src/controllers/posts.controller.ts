import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { PostsService } from "../services/posts.service";
import { PermissionService } from "../services/permission.service";
import ApiResponse from "../utils/apiResponse";
import { schedulerService } from "../services/scheduler.service";

export class PostsController {
  static async getPosts(req: SupabaseRequest, res: Response) {
    try {
      const db = req.supabase!;
      const userId = req.user_id!;
      const { publication, limit, offset } = req.query;

      let query = db
        .from("posts")
        .select("*, user_id(*)")
        .order("created_at", { ascending: false });

      if (publication) {
        query = query.eq("publication", publication);
      } else {
        // If no publication specified, maybe just return user's posts or handle differently
        // For now, let's return posts where the user is the author
        query = query.eq("user_id", userId);
      }

      // Apply pagination
      if (limit) {
        const l = parseInt(limit as string);
        if (!isNaN(l)) {
          query = query.limit(l);
        }
      }

      if (offset) {
        const o = parseInt(offset as string);
        if (!isNaN(o)) {
          // In Supabase JS client, offset is handled via range(from, to)
          const l = limit ? parseInt(limit as string) : 10;
          const from = o;
          const to = from + l - 1;
          query = query.range(from, to);
        }
      }

      const { data, error } = await query;

      if (error) throw error;

      return ApiResponse.success(
        res,
        "Posts retrieved successfully",
        data || [],
      );
    } catch (error: any) {
      console.error("[PostsController.getPosts] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async deletePost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      // Check existence and permission
      const { data: existingPost, error: fetchError } = await db
        .from("posts")
        .select("publication")
        .eq("id", id)
        .single();

      if (fetchError || !existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // Check permission
      const { PermissionService } =
        await import("../services/permission.service");
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (pubData) {
        const hasPermission = await permissionService.hasPermission(
          userId,
          pubData.business_id,
          "publication.post.delete",
        );

        // If generic permission missing, maybe allow author to delete?
        // This depends on business rules. Assuming strict or author.
        // Let's stick to permission check primarily.
        if (!hasPermission) {
          return ApiResponse.forbidden(
            res,
            "You do not have permission to delete this post",
          );
        }
      }

      const { error } = await db.from("posts").delete().eq("id", id);
      if (error) throw error;

      return ApiResponse.success(res, "Post deleted successfully");
    } catch (error: any) {
      console.error("[PostsController.deletePost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
  static async createPost(req: SupabaseRequest, res: Response) {
    try {
      const { publication, title, subtitle, body, cover_image } = req.body;
      const userId = req.user_id!;
      const db = req.supabase!;

      if (!publication) {
        return ApiResponse.badRequest(res, "Publication ID is required");
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.create",
      );

      if (!hasPermission) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to create posts in this publication",
        );
      }

      const postsService = new PostsService(db);
      const post = await postsService.createPost(
        { publication, title, subtitle, body, cover_image },
        userId,
      );

      return ApiResponse.created(res, "Post created successfully", post);
    } catch (error: any) {
      console.error("[PostsController.createPost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async getPostDetails(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id; // from authenticateOptional

      // Fetch post with author and publication
      const { data: post, error: postError } = await db
        .from("posts")
        .select("*, user_id(*), publication(*)")
        .eq("id", id)
        .single();

      if (postError || !post) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // 1. Get likes count
      const { count: likesCount } = await db
        .from("likes")
        .select("*", { count: "exact", head: true })
        .eq("post_id", id);

      // 2. Get comments count (top-level)
      const { count: commentsCount } = await db
        .from("comments")
        .select("*", { count: "exact", head: true })
        .eq("post_id", id)
        .is("parent_id", null);

      // 3. Check if current user liked the post
      let userLikedStatus = false;
      if (userId) {
        const { data: liked } = await db
          .from("likes")
          .select("id")
          .eq("post_id", id)
          .eq("user_id", userId)
          .maybeSingle();
        userLikedStatus = !!liked;
      }

      // 4. Check access permission
      let hasAccess = false;
      if (userId === post.user_id) {
        hasAccess = true;
      } else if (!post.visibility || post.visibility === "public") {
        hasAccess = true;
      } else if (userId) {
        // Check subscription
        const { data: subscription } = await db
          .from("subscriptions")
          .select("subscription_type, status")
          .eq("user_id", userId)
          .eq("publication_id", post.publication.id)
          .single();

        if (subscription && subscription.status === "active") {
          if (post.visibility === "free_subscribers") {
            hasAccess = true;
          } else if (post.visibility === "paid_subscribers") {
            hasAccess = subscription.subscription_type === "paid";
          }
        }
      }

      // 5. Sanitize body if no access
      if (!hasAccess && post.body) {
        post.body = PostsController.buildLockedPreview(post.body);
      }

      // 6. Fetch tipping data — look up the author's business subaccount
      let authorSubAccount = null;
      if (userId !== post.user_id && post.author) {
        const { data: bizData } = await db
          .from("businesses")
          .select("paystack_subaccount_code, flw_subaccount_id")
          .eq("owner_user_id", post.user_id)
          .not("paystack_subaccount_code", "is", null)
          .limit(1)
          .single();
        authorSubAccount = bizData ?? null;
      }

      // 7. Get publication analytics (subscriber and post counts)
      if (post.publication) {
        const [
          { count: subCount },
          { count: pCount }
        ] = await Promise.all([
          db.from("subscriptions")
            .select("*", { count: "exact", head: true })
            .eq("publication_id", post.publication.id),
          db.from("posts")
            .select("*", { count: "exact", head: true })
            .eq("publication", post.publication.id)
            .eq("status", "published")
        ]);

        post.publication.subscribers_count = subCount || 0;
        post.publication.posts_count = pCount || 0;
      }

      return ApiResponse.success(res, "Post details retrieved successfully", {
        post,
        likesCount: likesCount || 0,
        commentsCount: commentsCount || 0,
        liked: userLikedStatus,
        hasAccess,
        authorSubAccount,
      });
    } catch (error: any) {
      console.error("[PostsController.getPostDetails] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  private static buildLockedPreview(body: string) {
    if (!body) return body;

    try {
      const rawContent = JSON.parse(body);
      if (rawContent.blocks && Array.isArray(rawContent.blocks)) {
        const previewBlocks = rawContent.blocks
          .filter(
            (block: { text?: string; type?: string }) =>
              block.type === "atomic" || block.text?.trim(),
          )
          .slice(0, 3);

        if (previewBlocks.length > 0) {
          rawContent.blocks = previewBlocks;
          return JSON.stringify(rawContent);
        }
      }
    } catch {
      if (typeof body === "string") {
        return body.slice(0, 500);
      }
    }

    return body;
  }

  static async updatePost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // Check permission/ownership
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to update this post",
        );
      }

      // Guardrail: editing content must not change publish state.
      // Status transitions happen only via dedicated endpoints (publish/schedule/unschedule/archive/restore/unpublish).
      const safeBody: any = { ...(req.body || {}) };
      delete safeBody.status;
      delete safeBody.publish_time;
      delete safeBody.publish_type;

      const updatedPost = await postsService.updatePost(id, safeBody);

      return ApiResponse.success(res, "Post updated successfully", updatedPost);
    } catch (error: any) {
      console.error("[PostsController.updatePost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async unpublishPost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      if (existingPost.status !== "published") {
        return ApiResponse.badRequest(
          res,
          "Only published posts can be unpublished",
        );
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to unpublish this post",
        );
      }

      const unpublishedPost = await postsService.unpublishPost(id);

      return ApiResponse.success(
        res,
        "Post unpublished successfully",
        unpublishedPost,
      );
    } catch (error: any) {
      console.error("[PostsController.unpublishPost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async archivePost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to archive this post",
        );
      }

      // Use admin service to ensure archive persists (bypasses RLS issues for 'archived' status visibility)
      const { supabaseAdmin } = await import("../config/supabase");
      const adminPostsService = new PostsService(supabaseAdmin);
      const archivedPost = await adminPostsService.archivePost(id);

      return ApiResponse.success(
        res,
        "Post archived successfully",
        archivedPost,
      );
    } catch (error: any) {
      console.error("[PostsController.archivePost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async restorePost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to restore this post",
        );
      }

      // Use admin service to ensure update persists
      const { supabaseAdmin } = await import("../config/supabase");
      const adminPostsService = new PostsService(supabaseAdmin);
      const restoredPost = await adminPostsService.restorePost(id);

      return ApiResponse.success(
        res,
        "Post restored to published successfully",
        restoredPost,
      );
    } catch (error: any) {
      console.error("[PostsController.restorePost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async publishPost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to publish this post",
        );
      }

      const publishedPost = await postsService.publishPost(id);

      // Fetch full post details for notifications
      const { data: fullPost } = await db
        .from("posts")
        .select(
          `
          *,
          author:user_id(id, name, email),
          publication(id, name, description)
        `,
        )
        .eq("id", id)
        .single();

      if (fullPost && fullPost.publication) {
        // Trigger notifications asynchronously
        Promise.all([
          schedulerService.sendAuthorNotification(fullPost),
          schedulerService.sendToSubscribers(fullPost),
        ]).catch((err) => {
          console.error(
            "[PostsController.publishPost] Notification error:",
            err,
          );
        });
      }

      return ApiResponse.success(
        res,
        "Post published successfully",
        publishedPost,
      );
    } catch (error: any) {
      console.error("[PostsController.publishPost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async schedulePost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const { publish_time } = req.body;
      const db = req.supabase!;
      const userId = req.user_id!;

      if (!publish_time) {
        return ApiResponse.badRequest(
          res,
          "Publish time is required for scheduling",
        );
      }

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to schedule this post",
        );
      }

      const scheduledPost = await postsService.schedulePost(id, publish_time);

      return ApiResponse.success(
        res,
        "Post scheduled successfully",
        scheduledPost,
      );
    } catch (error: any) {
      console.error("[PostsController.schedulePost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  static async unschedulePost(req: SupabaseRequest, res: Response) {
    try {
      const { id } = req.params;
      const db = req.supabase!;
      const userId = req.user_id!;

      const postsService = new PostsService(db);
      const existingPost = await postsService.getPostById(id);

      if (!existingPost) {
        return ApiResponse.notFound(res, "Post not found");
      }

      if (existingPost.status !== "scheduled") {
        return ApiResponse.badRequest(
          res,
          "Only scheduled posts can be unscheduled",
        );
      }

      // Check permission
      const permissionService = new PermissionService(db);
      const { data: pubData } = await db
        .from("publications")
        .select("business_id")
        .eq("id", existingPost.publication)
        .single();

      if (!pubData) {
        return ApiResponse.notFound(res, "Publication not found");
      }

      const hasPermission = await permissionService.hasPermission(
        userId,
        pubData.business_id,
        "publication.post.update",
      );

      if (!hasPermission && existingPost.user_id !== userId) {
        return ApiResponse.forbidden(
          res,
          "You do not have permission to unschedule this post",
        );
      }

      const unscheduledPost = await postsService.unschedulePost(id);

      return ApiResponse.success(
        res,
        "Post unscheduled and reverted to draft",
        unscheduledPost,
      );
    } catch (error: any) {
      console.error("[PostsController.unschedulePost] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  // ============================================================================
  // Comments
  // ============================================================================

  static async createComment(req: SupabaseRequest, res: Response) {
    const { post_id, comment_text, is_private, parent_id } = req.body;
    const user_id = req.user_id;

    try {
      const { data, error } = await req
        .supabase!.from("comments")
        .insert([{ post_id, comment_text, is_private, parent_id }])
        .select("*")
        .single();

      if (error) throw error;

      // get the post details
      const { data: post, error: postError } = await req
        .supabase!.from("posts")
        .select("*, author: user_id(*)")
        .eq("id", post_id)
        .single();

      if (postError) throw postError;

      // get the user details
      const { data: user, error: userError } = await req
        .supabase!.from("users")
        .select("*")
        .eq("id", user_id)
        .single();

      if (userError) throw userError;

      // Don't send notification if the author is the same as the commenter
      if (post.author.id !== user.id) {
        // Trigger notification asynchronously
        const { notificationService } =
          await import("../services/notification.services");
        notificationService
          .sendNewCommentNotification(post, data, user)
          .catch((err) =>
            console.error(
              "[PostsController.createComment] Notification error:",
              err,
            ),
          );
      }

      return res.status(201).json({
        success: true,
        data: data,
      });
    } catch (error: any) {
      console.error("[PostsController.createComment] Error:", error?.message);
      return res.status(500).json({
        error: "Failed to create comment",
        details: error?.message,
      });
    }
  }

  static async getComments(req: SupabaseRequest, res: Response) {
    const { post_id } = req.params as { post_id?: string };
    const { page = "1", limit = "10" } = req.query as {
      page?: string;
      limit?: string;
    };
    const db = req.supabase!;
    const viewerId = (req as any).user_id as string | undefined;

    if (!post_id) {
      return res.status(400).json({
        error: "post_id is required",
      });
    }

    try {
      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const start = (pageNum - 1) * limitNum;
      const end = start + limitNum - 1;

      const { data, error } = await db
        .from("comments")
        .select("*, user_id(*)")
        .eq("post_id", post_id)
        .is("parent_id", null)
        .order("created_at", { ascending: false })
        .range(start, end);

      if (error) throw error;

      for (let i = 0; i < data.length; i++) {
        const comment = data[i] as any;
        const { data: replies, error: replyError } = await db
          .from("comments")
          .select("*, user_id(*)")
          .eq("parent_id", comment.id);

        if (replyError) throw replyError;

        data[i].replies = replies;
      }

      // If user is logged in, annotate comments (and replies) with liked_by_user.
      // comment_likes.user_id + comment_likes.post_id (post_id references comments.id - legacy naming)
      if (viewerId) {
        const topIds = (data || []).map((c: any) => c.id);
        const replyIds = (data || []).flatMap((c: any) =>
          Array.isArray(c.replies) ? c.replies.map((r: any) => r.id) : [],
        );
        const allIds = [...topIds, ...replyIds].filter(Boolean);

        if (allIds.length > 0) {
          const { data: likes, error: likeErr } = await db
            .from("comment_likes")
            .select("post_id")
            .eq("user_id", viewerId)
            .in("post_id", allIds);

          if (likeErr) throw likeErr;

          const likedSet = new Set((likes || []).map((l: any) => l.post_id));
          for (const c of data as any[]) {
            c.liked_by_user = likedSet.has(c.id);
            if (Array.isArray(c.replies)) {
              for (const r of c.replies) {
                r.liked_by_user = likedSet.has(r.id);
              }
            }
          }
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          comments: data,
          page: pageNum,
          limit: limitNum,
        },
      });
    } catch (error: any) {
      console.error("[PostsController.getComments] Error:", error?.message);
      return res.status(500).json({
        error: "Failed to fetch comments",
        details: error?.message,
      });
    }
  }

  static async getReplies(req: SupabaseRequest, res: Response) {
    const { comment_id } = req.params;
    const db = req.supabase!;
    const viewerId = (req as any).user_id as string | undefined;

    try {
      const { data, error } = await db
        .from("comments")
        .select("*, user_id(*)")
        .eq("parent_id", comment_id);

      if (error) throw error;

      if (viewerId && data && data.length > 0) {
        const ids = data.map((c: any) => c.id);
        const { data: likes, error: likeErr } = await db
          .from("comment_likes")
          .select("post_id")
          .eq("user_id", viewerId)
          .in("post_id", ids);
        if (likeErr) throw likeErr;
        const likedSet = new Set((likes || []).map((l: any) => l.post_id));
        for (const c of data as any[]) {
          (c as any).liked_by_user = likedSet.has(c.id);
        }
      }

      return res.status(200).json({
        success: true,
        data: data,
      });
    } catch (error: any) {
      console.error("[PostsController.getReplies] Error:", error?.message);
      return res.status(500).json({
        error: "Failed to fetch replies",
        details: error?.message,
      });
    }
  }

  static async updateComment(req: SupabaseRequest, res: Response) {
    const { id } = req.params;
    const { comment_text, is_private } = req.body;
    const user_id = req.user_id;

    try {
      // Check ownership
      const { data: existingComment, error: fetchError } = await req
        .supabase!.from("comments")
        .select("user_id")
        .eq("id", id)
        .single();

      if (fetchError || !existingComment) {
        return res.status(404).json({ error: "Comment not found" });
      }

      if (existingComment.user_id !== user_id) {
        return res
          .status(403)
          .json({ error: "You cannot edit someone else's comment" });
      }

      const { data, error } = await req
        .supabase!.from("comments")
        .update({
          comment_text,
          is_private,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();

      if (error) throw error;

      return res.status(200).json({
        success: true,
        data: data,
      });
    } catch (error: any) {
      console.error("[PostsController.updateComment] Error:", error?.message);
      return res.status(500).json({
        error: "Failed to update comment",
        details: error?.message,
      });
    }
  }

  static async deleteComment(req: SupabaseRequest, res: Response) {
    const { id } = req.params;
    const user_id = req.user_id;

    try {
      // Check ownership
      const { data: existingComment, error: fetchError } = await req
        .supabase!.from("comments")
        .select("user_id")
        .eq("id", id)
        .single();

      if (fetchError || !existingComment) {
        return res.status(404).json({ error: "Comment not found" });
      }

      if (existingComment.user_id !== user_id) {
        return res
          .status(403)
          .json({ error: "You cannot delete someone else's comment" });
      }

      const { error } = await req
        .supabase!.from("comments")
        .delete()
        .eq("id", id);

      if (error) throw error;

      return res.status(200).json({
        success: true,
        message: "Comment deleted successfully",
      });
    } catch (error: any) {
      console.error("[PostsController.deleteComment] Error:", error?.message);
      return res.status(500).json({
        error: "Failed to delete comment",
        details: error?.message,
      });
    }
  }

  /**
   * Upload image for a post
   * POST /api/posts/upload/image
   */
  static async uploadPostImage(req: SupabaseRequest, res: Response) {
    if (!req.file) {
      return ApiResponse.badRequest(res, "No file uploaded");
    }

    try {
      const db = req.supabase!;
      const { businessId, postId } = req.body;

      if (!businessId || !postId) {
        return ApiResponse.badRequest(
          res,
          "businessId and postId are required",
        );
      }

      const fileExt = req.file.originalname.split(".").pop();
      const fileName = `post_${Date.now()}.${fileExt}`;
      const filePath = `posts/${businessId}/${postId}/${fileName}`;

      const { StorageService } = await import("../services/storage.service");
      const storageService = new StorageService(db);
      const result = await storageService.uploadFile(
        "posts",
        filePath,
        req.file,
        true,
      );

      return ApiResponse.success(
        res,
        "Post image uploaded successfully",
        result,
      );
    } catch (error: any) {
      console.error("[uploadPostImage] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
}
