
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "https://nmizrlmjlurpialcjgex.supabase.co";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5taXpybG1qbHVycGlhbGNqZ2V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTAxNTEwMDIsImV4cCI6MjAyNTcyNzAwMn0.wzKu_LdgznQzy2Te7Sp7LSmPW5ytgh7g2Ta146DRoXE";
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
  console.log("--- CHECKING STORES SCHEMA ---");
  
  // Create a dummy query to see if we can select business_id
  const { data, error } = await supabase
    .from('stores')
    .select('id, user_id, business_id') 
    .limit(1);

  if (error) {
    console.log("Error querying business_id:", error.message);
    // If error says column does not exist, we know.
  } else {
    console.log("Success! Columns exist.");
    console.log("Data sample:", data);
  }
}

checkSchema();
