import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stock-movement causes, mirroring the widened CHECK on
 * stock_movements.reason (20260902_stock_movement_reasons.sql).
 */
export const STOCK_MOVEMENT_REASONS = [
  "sale",
  "return",
  "restock",
  "received",
  "damaged",
  "spoilage",
  "expired",
  "theft",
  "shrinkage",
  "found",
  "count",
  "transfer_out",
  "transfer_in",
  "adjustment",
] as const;

export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

export interface StockMovement {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity_change: number;
  reason: StockMovementReason;
  reference_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export class InventoryService {
  constructor(private supabase: SupabaseClient) {}

  /** Get stock-movement history for a product (newest first). */
  async getStockHistory(
    productId: string,
    limit: number = 50,
  ): Promise<StockMovement[]> {
    const { data, error } = await this.supabase
      .from("stock_movements")
      .select(
        "id, product_id, variant_id, quantity_change, reason, reference_id, notes, created_by, created_at",
      )
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return (data || []) as StockMovement[];
  }
}