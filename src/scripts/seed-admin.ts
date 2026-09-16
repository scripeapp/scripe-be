import { supabaseAdmin } from "../config/supabase";

const userId = "d307f6b4-1730-40e3-b945-19b37623b0e2";

async function main() {
  console.log("--- Seeding admin_users table (Take 2) ---");
  
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  if (userError) {
    console.warn("Could not find user in public.users, will use fallback data:", userError.message);
  }

  const adminData = {
    user_id: userId,
    role: "super_admin",
    name: user?.name || user?.full_name || "Owner Admin",
    email: user?.email || "owner@example.com",
    is_active: true,
    permissions: ["*"]
  };

  if (!adminData.email) {
      console.error("Critical: No email found for admin seeding");
      return;
  }

  console.log("Seeding admin with email:", adminData.email);

  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .upsert(adminData, { onConflict: "email" })
    .select()
    .single();
    
  if (error) {
    console.error("Error seeding admin:", error);
    return;
  }
  
  console.log("✅ Admin seeded successfully:", data);
}

main();
