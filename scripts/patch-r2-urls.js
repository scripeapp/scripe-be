/**
 * patch-r2-urls.js
 *
 * Replaces private R2 storage URLs with the public media.hilaq.com domain
 * in the course_lessons table.
 *
 * Usage:
 *   node scripts/patch-r2-urls.js          # dry-run (shows what would change)
 *   node scripts/patch-r2-urls.js --apply  # writes changes to DB
 */

const { createClient } = require("@supabase/supabase-js");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;

if (!R2_PUBLIC_URL || !R2_ACCOUNT_ID) {
  console.error("❌  Missing R2_PUBLIC_URL or R2_ACCOUNT_ID in .env");
  process.exit(1);
}

// The private endpoint pattern we want to replace
const PRIVATE_PREFIX = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const apply = process.argv.includes("--apply");

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\n🔍  Scanning course_lessons for private R2 URLs…`);
  console.log(`    Private prefix : ${PRIVATE_PREFIX}`);
  console.log(`    Public prefix  : ${R2_PUBLIC_URL}`);
  console.log(`    Mode           : ${apply ? "APPLY (will write)" : "DRY-RUN (read-only)"}\n`);

  // Fetch all lessons that contain the private URL
  const { data: rows, error } = await supabase
    .from("course_lessons")
    .select("id, content_url")
    .like("content_url", `${PRIVATE_PREFIX}%`);

  if (error) {
    console.error("❌  Query failed:", error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log("✅  No lessons with private R2 URLs found. Nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} lesson(s) to patch:\n`);

  let updated = 0;

  for (const row of rows) {
    const newUrl = row.content_url.replace(PRIVATE_PREFIX, R2_PUBLIC_URL);
    console.log(`  Lesson ${row.id}`);
    console.log(`    Before: ${row.content_url}`);
    console.log(`    After : ${newUrl}`);

    if (apply) {
      const { error: updateError } = await supabase
        .from("course_lessons")
        .update({ content_url: newUrl })
        .eq("id", row.id);

      if (updateError) {
        console.error(`    ❌  Failed: ${updateError.message}`);
      } else {
        console.log(`    ✅  Updated`);
        updated++;
      }
    }

    console.log();
  }

  if (apply) {
    console.log(`\n✅  Patched ${updated}/${rows.length} lesson(s).`);
  } else {
    console.log(
      `\nℹ️   Dry-run complete. Run with --apply to write these changes.\n`,
    );
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
