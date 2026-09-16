import { createClient, SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { supabaseAdmin as _supabaseAdmin } from "./supabaseAdmin";

export const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "Missing Supabase configuration: SUPABASE_URL or SUPABASE_ANON_KEY",
  );
}

export const SUPABASE_PROJECT_ID =
  process.env.SUPABASE_PROJECT_ID ||
  new URL(SUPABASE_URL).hostname.split(".")[0];

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);

export const supabaseAdmin: SupabaseClient = _supabaseAdmin ?? supabase;

export default supabase;
