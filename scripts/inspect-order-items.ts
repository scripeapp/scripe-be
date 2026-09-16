
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

async function inspectOrderItems() {
  console.log("Fetching a few paid/fulfilled orders...");
  
  const { data: orders, error } = await supabase
    .from("store_orders")
    .select("id, items, status")
    .in("status", ["paid", "fulfilled"])
    .limit(3);

  if (error) {
    console.error("Error fetching orders:", error);
    return;
  }

  console.log(`Found ${orders.length} orders.`);
  orders.forEach(o => {
    console.log(`\nOrder ${o.id} (${o.status}):`);
    console.log(JSON.stringify(o.items, null, 2));
  });
}

inspectOrderItems();
