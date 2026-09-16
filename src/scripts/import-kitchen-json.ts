/**
 * One-off importer: takes a restaurant/"kitchen" JSON export (see
 * docs/food-store-onboarding-prd.md for the target data model) and creates
 * a food store — branch, menu, categories, modifier groups/add-ons, and
 * items. Now a thin argv wrapper around provisionStoreFromKitchenJson
 * (the same function the dashboard AI agent's approve flow uses), so
 * rerunning this script against a known JSON doubles as a regression test
 * of that service.
 *
 * Usage:
 *   ts-node -r tsconfig-paths/register src/scripts/import-kitchen-json.ts <path-to-json> <business_id> <user_id>
 */
import "dotenv/config";
import * as fs from "fs";
import { supabaseAdmin } from "../config/supabase";
import { kitchenJsonSchema } from "../types/ai-agent.types";
import { provisionStoreFromKitchenJson } from "../services/ai/store-provisioning.service";

async function main() {
  const [, , jsonPath, businessId, userId] = process.argv;
  if (!jsonPath || !businessId || !userId) {
    console.error(
      "Usage: ts-node import-kitchen-json.ts <json-path> <business_id> <user_id>",
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const parsed = kitchenJsonSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error("JSON does not match the kitchen schema:");
    console.error(parsed.error.message);
    process.exit(1);
  }

  const result = await provisionStoreFromKitchenJson(
    supabaseAdmin,
    parsed.data,
    userId,
    businessId,
    (step) => console.log(`... ${step}`),
  );

  console.log("\n=== Import complete ===");
  console.log(`Store: ${result.storeName} (${result.slug})`);
  console.log(
    `Branch: ${result.counts.branches}, Menu: ${result.counts.menus}, Categories: ${result.counts.categories}`,
  );
  console.log(
    `Modifier groups: ${result.counts.modifierGroups} + ${result.counts.addonGroups} add-on group`,
  );
  console.log(`Items: ${result.counts.items}`);
  console.log(`Delivery zones: ${result.counts.deliveryZones}`);
  console.log(`\n=== Gaps (${result.gaps.length}) ===`);
  result.gaps.forEach((g, i) => console.log(`${i + 1}. ${g}`));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
