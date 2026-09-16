import { SupabaseClient } from "@supabase/supabase-js";

export class SocialService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async followUser(followerId: string, followingId: string) {
    if (followerId === followingId) {
      throw new Error("Users cannot follow themselves");
    }

    const { data, error } = await this.supabase
      .from("follows")
      .upsert(
        {
          follower_id: followerId,
          following_id: followingId,
          created_at: new Date().toISOString(),
        },
        {
          onConflict: "follower_id,following_id",
        },
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async unfollowUser(followerId: string, followingId: string) {
    const { error } = await this.supabase.from("follows").delete().match({
      follower_id: followerId,
      following_id: followingId,
    });

    if (error) throw error;
    return true;
  }

  async toggleLike(userId: string, objectId: string, objectType: string) {
    const isPost = objectType === "post";
    const isComment = objectType === "comment";

    // Current DB schema supports likes for:
    // - posts: public.likes(user_id, post_id) unique(user_id, post_id)
    // - comments: public.comment_likes(user_id, post_id) (post_id references comments.id)
    if (!isPost && !isComment) {
      throw new Error(
        "Likes are currently supported for posts and comments only.",
      );
    }

    const table = isPost ? "likes" : "comment_likes";
    const idField = isPost ? "post_id" : "post_id"; // comment_likes uses post_id for comment_id (legacy naming)

    // Check if like exists
    const { data: existingLike, error: fetchError } = await this.supabase
      .from(table)
      .select("*")
      .match({
        user_id: userId,
        [idField]: objectId,
      })
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (existingLike) {
      // Remove like
      const { error: deleteError } = await this.supabase
        .from(table)
        .delete()
        .match({ id: existingLike.id });

      if (deleteError) throw deleteError;
      return { liked: false };
    } else {
      // Add like
      const { data, error: insertError } = await this.supabase
        .from(table)
        .insert({
          user_id: userId,
          [idField]: objectId,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) throw insertError;
      return { liked: true, data };
    }
  }
}
