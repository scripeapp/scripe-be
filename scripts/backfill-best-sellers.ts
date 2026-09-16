
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

// Explicitly load .env from project root
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function backfillBestSellers() {
  const BATCH_SIZE = 1000;
  let hasMore = true;
  let page = 0;
  let allOrders: any[] = [];

  while (hasMore) {
    console.log(`[${new Date().toISOString()}] Fetching page ${page} (limit ${BATCH_SIZE})...`);
    
    // Fetch valid orders with pagination
    const { data: orders, error } = await supabase
      .from("store_orders")
      .select("id, items")
      .in("status", ["paid", "fulfilled"])
      .range(page * BATCH_SIZE, (page + 1) * BATCH_SIZE - 1);

    if (error) {
      console.error(`[${new Date().toISOString()}] Error fetching orders page ${page}:`, error);
      process.exit(1);
    }

    if (orders && orders.length > 0) {
      allOrders = [...allOrders, ...orders];
      console.log(`[${new Date().toISOString()}] Loaded ${orders.length} orders. Total: ${allOrders.length}`);
      if (orders.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }

  console.log(`[${new Date().toISOString()}] Finished fetching. Total valid orders: ${allOrders.length}`);
  const orders = allOrders;

  // 2. Aggregate sales
  const salesMap: Record<string, number> = {};

  orders.forEach(order => {
    if (Array.isArray(order.items)) {
      order.items.forEach((item: any) => {
        if (item.product_id) {
          const qty = parseInt(String(item.quantity) || "1", 10);
          salesMap[item.product_id] = (salesMap[item.product_id] || 0) + qty;
        }
      });
    }
  });

  const productIds = Object.keys(salesMap);
  console.log(`Found ${productIds.length} products with sales.`);

  // 3. Update products
  console.log("Updating products...");
  
  let updatedCount = 0;
  
  // Fetch existing counts just to see change (optional, skipping for speed)
  
  for (const productId of productIds) {
    const count = salesMap[productId];
    
    const { error: updateError } = await supabase
      .from("products")
      .update({ orders_count: count })
      .eq("id", productId);

    if (updateError) {
      console.error(`Failed to update product ${productId}:`, updateError.message);
    } else {
      updatedCount++;
      if (updatedCount % 10 === 0) {
        process.stdout.write(".");
      }
    }
  }

  console.log(`\nSuccessfully updated ${updatedCount} products.`);
}

backfillBestSellers();
