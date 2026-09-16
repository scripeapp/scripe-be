import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

let adminClient: SupabaseClient | null = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  // persistSession: false + autoRefreshToken: false ensures the service-role key is
  // always sent as the Authorization header and is never overridden by a cached user JWT.
  adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
} else {
  console.error(`[Config] Failed to initialize Supabase Admin Client. URL: ${!!SUPABASE_URL}, Key: ${!!SUPABASE_SERVICE_ROLE_KEY}`);
}

export const supabaseAdmin: SupabaseClient | null = adminClient;
export default supabaseAdmin;
