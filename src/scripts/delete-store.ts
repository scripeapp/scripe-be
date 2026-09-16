import "dotenv/config";
import { supabaseAdmin } from "../config/supabase";
import { StoreService } from "../services/store.service";

async function main() {
  const [, , storeId, userId, businessId] = process.argv;
  if (!storeId || !userId || !businessId) {
    console.error("Usage: ts-node delete-store.ts <store_id> <user_id> <business_id>");
    process.exit(1);
  }
  const service = new StoreService(supabaseAdmin);

  const { data: products } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("store_id", storeId);
  console.log(`Deleting ${products?.length || 0} products...`);
  for (const p of products || []) {
    await supabaseAdmin.from("products").delete().eq("id", p.id);
  }

  console.log("Deleting store...");
  await service.deleteStore(userId, storeId, businessId);
  console.log("Done.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
