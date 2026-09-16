import { supabaseAdmin } from "../config/supabase";

async function main() {
  console.log("--- Listing all tables in public schema ---");
  
  const { data, error } = await supabaseAdmin
    .rpc("debug_list_tables"); // If this RPC exists

  if (error) {
    console.log("RPC debug_list_tables failed, trying direct query on pg_class");
    
    const { data: tables, error: pgError } = await supabaseAdmin
      .from("pg_class") // This might not be accessible via PostgREST
      .select("relname")
      .limit(10);
      
    if (pgError) {
      console.error("Direct query failed:", pgError);
      
      // Try to query common table names
      const commonTables = ["users", "profiles", "memberships", "businesses", "admin_users"];
      for (const table of commonTables) {
        const { error: checkError } = await supabaseAdmin.from(table).select("count").limit(1);
        console.log(`Table ${table}: ${checkError ? "MISSING" : "EXISTS"}`);
      }
    } else {
      console.log("Tables:", tables);
    }
  } else {
    console.log("Tables:", data);
  }
}

main();
