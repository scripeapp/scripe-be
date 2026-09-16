import { Response } from 'express';
import { SupabaseRequest } from '../types/http';

export const getUserPublications = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const businessId = (req as any).businessId || req.query.business_id;

  if (!businessId) {
    return res.status(400).json({ success: false, error: "Business context required" });
  }

  try {
    const { data, error } = await supabaseClient
      .from("publications")
      .select("*, subscriptions(count), posts(count)")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Transform data to match expected format with counts
    const formattedData = data.map((pub: any) => ({
      ...pub,
      subscriber_count: pub.subscriptions?.[0]?.count || 0,
      post_count: pub.posts?.[0]?.count || 0
    }));

    return res.status(200).json({
      success: true,
      message: "User publications retrieved successfully",
      data: formattedData,
    });
  } catch (error: any) {
    console.error("[getUserPublications] Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get user publications",
      data: error.message,
    });
  }
};
