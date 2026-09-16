
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

async function checkBestSellers() {
  console.log("Checking products orders_count...");
  
  // Get top 20 products by orders_count
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, orders_count")
    .order("orders_count", { ascending: false, nullsFirst: false })
    .limit(20);

  if (error) {
    console.error("Error fetching products:", error);
    return;
  }

  console.log(`Found ${products.length} products. Top selling:`);
  products.forEach(p => {
    console.log(`- ${p.name} (${p.id}): ${p.orders_count}`);
  });

  // Check if any have orders_count > 0
  const hasSales = products.some(p => p.orders_count > 0);
  if (!hasSales) {
    console.log("\nWARNING: No products have orders_count > 0.");
    console.log("This explains why 'Best Sellers' might look random.");
  } else {
    console.log("\nSome products have sales recorded.");
  }
}

checkBestSellers();
