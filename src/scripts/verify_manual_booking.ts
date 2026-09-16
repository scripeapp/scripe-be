
import { createClient } from "@supabase/supabase-js";
import { StoreService } from "../services/store.service";
import { BookingService } from "../services/booking.service";
import { ProductBaseSchema } from "../types/store";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Initialize Supabase Admin client (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const storeService = new StoreService(supabaseAdmin as any);
const bookingService = new BookingService(supabaseAdmin as any);

async function verifyManualBookingFlow() {
  console.log("Starting verification of Manual Booking Flow...");

  const testEmail = `test.manual.${Date.now()}@example.com`;
  const ownerEmail = `owner.manual.${Date.now()}@example.com`;
  let userId: string;
  let ownerId: string;
  let businessId: string;
  let storeId: string;
  let autoConfirmProductId: string;
  let manualConfirmProductId: string;

  try {
    // 1. Setup Test User and Owner
    console.log("Creating test users...");
    const { data: userAuth, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail,
      email_confirm: true,
      password: "password123",
    });
    if (userError) throw userError;
    userId = userAuth.user.id;

    const { data: ownerAuth, error: ownerError } = await supabaseAdmin.auth.admin.createUser({
      email: ownerEmail,
      email_confirm: true,
      password: "password123",
    });
    if (ownerError) throw ownerError;
    ownerId = ownerAuth.user.id;

    // 2. Create Business
    console.log("Creating business...");
    const { data: business, error: businessError } = await supabaseAdmin
      .from("businesses")
      .insert({
        owner_user_id: ownerId,
        name: "Manual Booking Test Business",
        slug: `manual-test-${Date.now()}`,
      })
      .select()
      .single();
    if (businessError) throw businessError;
    businessId = business.id;

    // 3. Create Store
    console.log("Creating store...");
    const { data: store, error: storeError } = await supabaseAdmin
      .from("stores")
      .insert({
        business_id: businessId,
        user_id: ownerId, // Some schema versions use user_id on store too
        name: "Manual Booking Test Store",
        slug: `manual-store-${Date.now()}`,
        currency: "NGN",
      })
      .select()
      .single();
    if (storeError) throw storeError;
    storeId = store.id;

    // 4. Create Auto-Confirm Product
    console.log("Creating auto-confirm product...");
    const autoProductData = {
        store_id: storeId,
        name: "Auto Service",
        description: "Auto confirm service",
        price: 0, // Free for easy testing
        currency: "NGN",
        type: "service",
        status: "published",
        service: {
            duration_minutes: 60,
            location: "Zoom",
            availability: "9-5",
            approval_required: false // DEFAULT
        },
        images: [],
        category_ids: []
    };
    
    // We insert directly to avoid service layer overhead if schema doesn't match perfectly with payload
    const { data: autoProduct, error: autoProdError } = await supabaseAdmin
        .from("products")
        .insert(autoProductData)
        .select()
        .single();
    if (autoProdError) throw autoProdError;
    autoConfirmProductId = autoProduct.id;


    // 5. Create Manual-Confirm Product
    console.log("Creating manual-confirm product...");
    const manualProductData = {
        store_id: storeId,
        name: "Manual Service",
        description: "Manual confirm service",
        price: 0,
        currency: "NGN",
        type: "service",
        status: "published",
        service: {
            duration_minutes: 60,
            location: "Zoom",
            availability: "9-5",
            approval_required: true // MANUAL
        },
        images: [],
        category_ids: []
    };
    
    const { data: manualProduct, error: manualProdError } = await supabaseAdmin
        .from("products")
        .insert(manualProductData)
        .select()
        .single();
    if (manualProdError) throw manualProdError;
    manualConfirmProductId = manualProduct.id;


    // 6. Test Auto-Confirm Flow
    console.log("\n--- Testing Auto-Confirm Flow ---");
    const autoOrderPayload = {
        store_id: storeId,
        customer: { name: "Test User", email: testEmail },
        items: [{
            product_id: autoConfirmProductId,
            quantity: 1,
            slot: { date: "2025-01-01", startTime: "10:00", endTime: "11:00" }
        }],
        user_id: userId
    };
    
    // We use processFreePurchase directly
    const { order: autoOrder } = await storeService.processFreePurchase(autoOrderPayload);
    console.log("Auto Order created:", autoOrder.id);
    
    // Verify Booking Status
    const { data: autoBooking } = await supabaseAdmin
        .from("service_bookings")
        .select("*")
        .eq("order_id", autoOrder.id)
        .single();
        
    console.log(`Auto Booking Status: ${autoBooking.status} (Expected: confirmed)`);
    if (autoBooking.status !== 'confirmed') throw new Error("Auto booking should be confirmed");
    if (autoBooking.approval_required === true) throw new Error("Auto booking approval_required should be false/null");


    // 7. Test Manual-Confirm Flow
    console.log("\n--- Testing Manual-Confirm Flow ---");
    const manualOrderPayload = {
        store_id: storeId,
        customer: { name: "Test User", email: testEmail },
        items: [{
            product_id: manualConfirmProductId,
            quantity: 1,
            slot: { date: "2025-01-02", startTime: "10:00", endTime: "11:00" }
        }],
        user_id: userId
    };
    
    const { order: manualOrder } = await storeService.processFreePurchase(manualOrderPayload);
    console.log("Manual Order created:", manualOrder.id);
    
    // Verify Booking Status
    const { data: manualBooking } = await supabaseAdmin
        .from("service_bookings")
        .select("*")
        .eq("order_id", manualOrder.id)
        .single();
        
    console.log(`Manual Booking Status: ${manualBooking.status} (Expected: pending)`);
    if (manualBooking.status !== 'pending') throw new Error("Manual booking should be pending");
    if (!manualBooking.approval_required) throw new Error("Manual booking approval_required should be true");

    console.log("\nSUCCESS: All verification checks passed!");

  } catch (error) {
    console.error("\nFAILURE: Verification failed:", error);
  } finally {
      // Cleanup (optional, keeping data for debug might be useful)
      // await supabaseAdmin.auth.admin.deleteUser(userId);
      // await supabaseAdmin.auth.admin.deleteUser(ownerId);
      console.log("Done.");
  }
}

// Run verification
verifyManualBookingFlow();
