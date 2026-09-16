import { SupabaseClient } from "@supabase/supabase-js";
import { Post } from "../types/models";

export class PostsService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async getPostById(postId: string): Promise<Post | null> {
    const { data, error } = await this.supabase
      .from("posts")
      .select("*")
      .eq("id", postId)
      .single();

    if (error || !data) return null;
    return data as Post;
  }

  async createPost(data: Partial<Post>, userId: string): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from("posts")
      .insert({
        ...data,
        user_id: userId,
        status: "draft",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }

  async updatePost(postId: string, data: Partial<Post>): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        ...data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }

  async publishPost(postId: string): Promise<Post> {
    const now = new Date().toISOString();
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        status: "published",
        publish_time: now,
        updated_at: now,
        publish_type: "now",
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;

    // We don't trigger notifications here directly to avoid blocking the request.
    // The scheduler or a background worker can handle notifications.
    // However, if immediate notification is required, we can call the notification logic here.

    return post as Post;
  }

  async schedulePost(postId: string, publishTime: string): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        status: "scheduled",
        publish_time: publishTime,
        publish_type: "later",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }

  async unschedulePost(postId: string): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        status: "draft",
        publish_time: null,
        publish_type: "later",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }

  async unpublishPost(postId: string): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        status: "draft",
        publish_time: null,
        publish_type: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }

  async archivePost(postId: string): Promise<Post> {
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        status: "archived",
        publish_time: null,
        publish_type: "later",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }

  async restorePost(postId: string): Promise<Post> {
    const now = new Date().toISOString();
    const { data: post, error } = await this.supabase
      .from("posts")
      .update({
        status: "published",
        publish_time: now,
        publish_type: "now",
        updated_at: now,
      })
      .eq("id", postId)
      .select()
      .single();

    if (error) throw error;
    return post as Post;
  }
}
