import { supabaseAdmin } from "../config/supabase";

const userId = "d307f6b4-1730-40e3-b945-19b37623b0e2";

async function main() {
  console.log("--- Checking admin_users table directly ---");
  
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("*");
    
  if (error) {
    console.error("Error fetching admins:", error);
    return;
  }
  
  console.log("Total admins found:", admins?.length || 0);
  console.log("Admins:", JSON.stringify(admins, null, 2));
  
  const found = admins?.find((a: any) => a.user_id === userId);
  if (found) {
    console.log("\n✅ User FOUND in admin_users:", found);
  } else {
    console.log("\n❌ User NOT FOUND in admin_users table");
  }
}

main();
