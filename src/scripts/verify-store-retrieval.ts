import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { storeService } from "../services/store.service";
import { randomUUID } from "crypto";
import supabaseAdmin from "../../src/config/supabaseAdmin";

// Load environment variables
config({ path: resolve(__dirname, "../../.env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Mock store service with admin client
const service = new (storeService.constructor as any)(supabase);

async function runVerification() {
  try {
    console.log("Starting verification...");

    // 1. Create a test user and store
    console.log("\n1. Setting up test store...");

    // Create auth user
    if (!supabaseAdmin) throw new Error("Supabase Admin not initialized");

    const { data: userData, error: userError } =
      await supabaseAdmin.auth.admin.createUser({
        email: `test-${Date.now()}@example.com`,
        password: "password123",
        email_confirm: true,
      });

    if (userError) throw userError;
    const userId = userData.user.id;

    const store = await service.initUserStore(userId, {
      name: "Verification Store",
      slug: `verification-store-${Date.now()}`,
    });

    // 2. Add multiple products
    console.log("\n2. Seeding products...");
    for (let i = 1; i <= 15; i++) {
      await service.addProduct(store.id, {
        name: `Product ${i}`,
        description: `Description for product ${i}`,
        price: 100 * i,
        status: i % 2 === 0 ? "published" : "draft",
        type: "digital",
        store_id: store.id,
      } as any);
    }
    console.log("Added 15 products");

    // 3. Test Product Pagination
    console.log("\n3. Testing Product Pagination...");

    // Page 1
    const page1 = await service.getStoreProducts(store.id, {
      page: 1,
      limit: 10,
    });
    console.log(
      `Page 1: Returned ${page1.data.length} items (Total: ${page1.meta.total})`,
    );
    if (page1.data.length !== 10) throw new Error("Page 1 length mismatch");

    // Page 2
    const page2 = await service.getStoreProducts(store.id, {
      page: 2,
      limit: 10,
    });
    console.log(`Page 2: Returned ${page2.data.length} items`);
    if (page2.data.length !== 5) throw new Error("Page 2 length mismatch");

    // Filter by status
    const published = await service.getStoreProducts(store.id, {
      page: 1,
      limit: 10,
      status: "published",
    });
    console.log(`Published only: Returned ${published.data.length} items`);
    if (published.data.some((p: any) => p.status !== "published"))
      throw new Error("Filter mismatch");

    // Search
    const search = await service.getStoreProducts(store.id, {
      page: 1,
      limit: 10,
      search: "Product 10", // Should match "Product 10"
    });
    console.log(`Search 'Product 10': Returned ${search.data.length} items`);
    if (search.data.length !== 1) throw new Error("Search mismatch");

    // 4. Test Discount Pagination
    console.log("\n4. Testing Discount Pagination...");
    await service.addDiscountCode(store.id, {
      code: "TEST1",
      type: "percentage",
      value: 10,
      is_active: true,
    } as any);
    await service.addDiscountCode(store.id, {
      code: "TEST2",
      type: "fixed",
      value: 500,
      is_active: false,
    } as any);

    const allDiscounts = await service.getStoreDiscounts(store.id, {
      page: 1,
      limit: 10,
    });
    console.log(`All discounts: ${allDiscounts.data.length}`);
    if (allDiscounts.data.length !== 2)
      throw new Error("Discount count mismatch");

    const activeDiscounts = await service.getStoreDiscounts(store.id, {
      page: 1,
      limit: 10,
      is_active: true,
    });
    console.log(`Active discounts: ${activeDiscounts.data.length}`);
    if (activeDiscounts.data.length !== 1)
      throw new Error("Active discount mismatch");

    console.log("\nVerification SUCCESS!");

    // Cleanup could happen here but for now we leave data for inspection if needed
  } catch (error) {
    console.error("Verification FAILED:", error);
    process.exit(1);
  }
}

runVerification();
