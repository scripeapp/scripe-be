import "dotenv/config";
import supabaseAdmin from "../config/supabaseAdmin";

/**
 * Backfill script to update payment_method for existing cash orders
 * 
 * Uses the admin client (service role) to bypass RLS policies.
 * Verifies updates by re-checking the database after each update.
 */
async function backfillCashPaymentMethod() {
  console.log("Starting backfill of payment_method for cash orders...\n");

  // Verify admin client is available
  if (!supabaseAdmin) {
    console.error("ERROR: supabaseAdmin is not configured.");
    console.error("Make sure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in your .env file.");
    process.exit(1);
  }

  // Step 1: Fetch all orders with payment_reference starting with 'CASH-'
  const { data: cashOrders, error: ordersError } = await supabaseAdmin
    .from("orders")
    .select("id, payment_reference")
    .like("payment_reference", "CASH-%");

  if (ordersError) {
    console.error("Error fetching cash orders:", ordersError);
    process.exit(1);
  }

  if (!cashOrders || cashOrders.length === 0) {
    console.log("No cash orders found. Nothing to update.");
    process.exit(0);
  }

  console.log(`Found ${cashOrders.length} cash order(s) to process.\n`);

  // Step 2: Update issued_tickets for each cash order with verification
  let totalUpdated = 0;
  let totalVerified = 0;
  let totalErrors = 0;

  for (const order of cashOrders) {
    console.log(`\nProcessing order: ${order.id} (${order.payment_reference})`);

    // Fetch tickets for this order
    const { data: tickets, error: fetchError } = await supabaseAdmin
      .from("issued_tickets")
      .select("id, payment_method")
      .eq("order_id", order.id);

    if (fetchError) {
      console.error(`  ❌ Error fetching tickets:`, fetchError.message);
      totalErrors++;
      continue;
    }

    if (!tickets || tickets.length === 0) {
      console.log(`  ⚠️  No tickets found for this order`);
      continue;
    }

    console.log(`  Found ${tickets.length} ticket(s)`);

    // Update all tickets for this order
    const ticketIds = tickets.map((t) => t.id);
    const { error: updateError } = await supabaseAdmin
      .from("issued_tickets")
      .update({ payment_method: "cash" })
      .in("id", ticketIds);

    if (updateError) {
      console.error(`  ❌ Error updating tickets:`, updateError.message);
      totalErrors++;
      continue;
    }

    // VERIFICATION: Re-fetch to confirm update
    const { data: verifyTickets, error: verifyError } = await supabaseAdmin
      .from("issued_tickets")
      .select("id, payment_method")
      .in("id", ticketIds);

    if (verifyError) {
      console.error(`  ❌ Error verifying update:`, verifyError.message);
      totalErrors++;
      continue;
    }

    // Check if updates actually applied
    const updatedCount = verifyTickets?.filter((t) => t.payment_method === "cash").length || 0;
    const notUpdatedCount = (verifyTickets?.length || 0) - updatedCount;

    if (notUpdatedCount > 0) {
      console.error(`  ❌ VERIFICATION FAILED: ${notUpdatedCount} ticket(s) not updated!`);
      console.error(`     Current values:`, verifyTickets?.map(t => ({ id: t.id, payment_method: t.payment_method })));
      totalErrors++;
    } else {
      console.log(`  ✅ Verified: ${updatedCount} ticket(s) updated to payment_method='cash'`);
      totalVerified += updatedCount;
    }

    totalUpdated += tickets.length;
  }

  console.log("\n" + "=".repeat(50));
  console.log("BACKFILL COMPLETE");
  console.log("=".repeat(50));
  console.log(`Total orders processed: ${cashOrders.length}`);
  console.log(`Total tickets attempted: ${totalUpdated}`);
  console.log(`Total tickets verified: ${totalVerified}`);
  console.log(`Total errors: ${totalErrors}`);
  
  if (totalErrors > 0) {
    console.log("\n⚠️  Some updates failed! Check errors above.");
  } else if (totalVerified === totalUpdated) {
    console.log("\n✅ All updates verified successfully!");
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

// Run the backfill
backfillCashPaymentMethod();
