
import { supabaseAdmin as supabase } from "../src/config/supabase";

async function checkVariants() {
  console.log("Checking recent products and variants...");

  // Get recent physical products
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, type, store_id, status")
    .eq("type", "physical")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error fetching products:", error);
    return;
  }

  if (!products || products.length === 0) {
    console.log("No physical products found.");
    return;
  }

  console.log(`Found ${products.length} recent physical products:`);

  for (const product of products) {
    console.log(`\nProduct: ${product.name} (ID: ${product.id}, Status: ${product.status})`);
    
    // Get store info
    const { data: store } = await supabase
      .from("stores")
      .select("slug, is_live")
      .eq("id", product.store_id)
      .single();
      
    console.log(`  Store Slug: ${store?.slug}, Is Live: ${store?.is_live}`);

    // Get variants
    const { data: variants, error: vError } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", product.id);

    if (vError) {
      console.error(`  Error fetching variants: ${vError.message}`);
      continue;
    }

    if (!variants || variants.length === 0) {
      console.log("  No variants found for this product.");
    } else {
      console.log(`  Found ${variants.length} variants:`);
      variants.forEach(v => {
        console.log(`    - ID: ${v.id}, Name: ${v.name}, Active: ${v.is_active}, Group: ${v.group_name}`);
      });
    }
  }
}

checkVariants();
