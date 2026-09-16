/**
 * One-off importer: takes the Spice Route Kitchens multi-branch JSON export
 * and creates a food store — branches (with tax rate/manager/format),
 * delivery zones, menus (branch-scoped), categories, modifier groups/options
 * (branch-scoped/excluded), add-ons, and items (with per-branch
 * price/availability overrides) — using the real StoreService methods (same
 * validation/defaults the app itself uses, just called directly instead of
 * over HTTP).
 *
 * Branch-aware fields (menu.branch_ids, modifier_group/option.branch_ids,
 * branch_catalog_overrides, store_delivery_zones, branch tax_rate/
 * manager/format) require the 20260722_* migrations to be applied first —
 * see supabase/migrations/.
 *
 * Structurally different from import-kitchen-json.ts: this source has
 * multiple branches, multiple menus (each scoped to a subset of branches),
 * items that can belong to more than one menu, per-branch modifier
 * restrictions, per-branch product price/availability overrides, and a
 * brand-level loyalty program. See the printed gap list for what still
 * couldn't be mapped (combos, loyalty program, a few branch fields with no
 * platform equivalent).
 *
 * Usage:
 *   ts-node -r tsconfig-paths/register src/scripts/import-spiceroute-json.ts <path-to-json> <business_id> <user_id>
 */
import "dotenv/config";
import * as fs from "fs";
import { supabaseAdmin } from "../config/supabase";
import { StoreService } from "../services/store.service";

// Approximate NGN-per-USD rate used only to populate the platform's
// mandatory NGN base price. The real, authoritative price is the exact USD
// figure from the source JSON, set via currency_prices.USD — that's what
// actually charges customers when checkout currency is USD. The NGN base is
// a placeholder, not a real conversion.
const USD_TO_NGN_RATE = 1500;

interface JsonModifierOption {
  name: string;
  price_delta: number;
  branch_exclude?: string[];
}
interface JsonModifierGroup {
  id: string;
  name: string;
  selection_type: "single" | "multiple";
  min_selections: number;
  max_selections: number | null;
  branch_restricted_to?: string[];
  options: JsonModifierOption[];
}
interface JsonAddOn {
  id: string;
  name: string;
  price: number;
}
interface JsonBranch {
  id: string;
  name: string;
  format?: string;
  address: { line1: string; city: string; state: string; zip?: string };
  phone?: string;
  seating?: unknown;
  service_types: string[];
  tax_rate?: number;
  hours: Record<string, string>;
  menus_available: string[];
  kitchen_avg_prep_minutes?: number;
  airport_surcharge_pct?: number;
  manager?: string;
}
interface JsonMenu {
  id: string;
  name: string;
  active_schedule?: string;
  branches_available: string[];
  categories: string[];
  requires_full_bar?: boolean;
  min_order?: number;
  lead_time_hours?: number;
}
interface JsonItem {
  id: string;
  name: string;
  category: string;
  menu_ids: string[];
  base_price: number;
  allergens?: string[];
  tags?: string[];
  modifier_groups: string[];
}
interface JsonBranchItemOverride {
  branch_id: string;
  item_id: string;
  price_override?: number;
  available?: boolean;
  reason?: string;
}
interface JsonDeliveryZoneEntry {
  branch_id: string;
  zones: Array<{
    zip: string;
    fee: number;
    min_order?: number;
    est_minutes?: number;
  }>;
}
interface SpiceRouteJson {
  brand: {
    name: string;
    description: string;
    currency: string;
    loyalty_program?: unknown;
  };
  branches: JsonBranch[];
  menus: JsonMenu[];
  modifier_groups: JsonModifierGroup[];
  add_ons: JsonAddOn[];
  items: JsonItem[];
  branch_item_overrides?: JsonBranchItemOverride[];
  combos?: unknown[];
  delivery_zones?: JsonDeliveryZoneEntry[];
}

const gaps: string[] = [];

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// Known "hours" group keys in this source -> the weekdays they cover.
const HOUR_GROUPS: Record<string, string[]> = {
  mon_thu: ["monday", "tuesday", "wednesday", "thursday"],
  fri_sat: ["friday", "saturday"],
  sun: ["sunday"],
  mon_fri: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  sat_sun: ["saturday", "sunday"],
  daily: [...WEEKDAYS],
  mon_sat: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
};

function parseRange24h(raw: string): { open: string; close: string } | null {
  const parts = raw.split("-").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const [open, close] = parts;
  if (!/^\d{2}:\d{2}$/.test(open) || !/^\d{2}:\d{2}$/.test(close)) return null;
  return { open, close };
}

function buildBusinessHours(
  hours: Record<string, string>,
): Record<string, { open: string; close: string } | null> {
  const result: Record<string, { open: string; close: string } | null> = {};
  WEEKDAYS.forEach((d) => (result[d] = null));
  for (const [key, raw] of Object.entries(hours)) {
    const days = HOUR_GROUPS[key];
    if (!days) {
      gaps.push(`Unrecognised hours group key "${key}" (value "${raw}") — skipped.`);
      continue;
    }
    const range = parseRange24h(raw);
    if (!range) {
      gaps.push(`Couldn't parse hours value "${raw}" for group "${key}" — skipped.`);
      continue;
    }
    for (const d of days) result[d] = range;
  }
  return result;
}

const KNOWN_OPERATION_TYPES = ["dine_in", "pickup", "delivery", "curbside"] as const;
type OperationType = (typeof KNOWN_OPERATION_TYPES)[number];

function mapOperationTypes(serviceTypes: string[]): OperationType[] {
  const mapped = new Set<OperationType>();
  const unknown: string[] = [];
  for (const t of serviceTypes) {
    if ((KNOWN_OPERATION_TYPES as readonly string[]).includes(t)) {
      mapped.add(t as OperationType);
    } else if (t === "catering_pickup" || t === "takeout") {
      mapped.add("pickup");
    } else {
      unknown.push(t);
    }
  }
  if (unknown.length > 0) {
    gaps.push(
      `service_types included unrecognised value(s): ${unknown.join(", ")} — dropped.`,
    );
  }
  if (mapped.size === 0) mapped.add("pickup");
  return Array.from(mapped);
}

async function main() {
  const [, , jsonPath, businessId, userId] = process.argv;
  if (!jsonPath || !businessId || !userId) {
    console.error(
      "Usage: ts-node import-spiceroute-json.ts <json-path> <business_id> <user_id>",
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const json: SpiceRouteJson = JSON.parse(raw);
  const service = new StoreService(supabaseAdmin);

  // 1. Store
  const store = await service.createStore(userId, businessId, {
    name: json.brand.name,
    sells_in_person: true,
  });
  console.log(`Store created: ${store.name} (${store.id}), slug=${store.slug}`);

  await service.saveUserStore(
    userId,
    store.id,
    {
      appearance: {
        ...(store as any).appearance,
        description: json.brand.description,
      } as any,
      supported_currencies: ["NGN", "USD"],
      payment_currency: "USD",
    } as any,
    businessId,
  );
  gaps.push(
    `products.price (NGN base) was computed using an approximate placeholder rate of ₦${USD_TO_NGN_RATE}/$1 — it is NOT a real FX rate, just a required non-null base value the platform's schema demands. The authoritative price is currency_prices.USD, set to the exact JSON dollar amount, which is what actually charges customers when checkout currency is USD (store.payment_currency was set to "USD" so that's the default).`,
  );

  if (json.brand.loyalty_program) {
    gaps.push(
      `brand.loyalty_program ("${(json.brand.loyalty_program as any).name}" — points-per-dollar, tiers, redemption rate) skipped entirely — no points/rewards/loyalty system exists anywhere in the store data model.`,
    );
  }

  // 2. Branches
  const branchIdMap = new Map<string, string>(); // json branch id -> db id
  for (const [i, b] of json.branches.entries()) {
    const businessHours = buildBusinessHours(b.hours);
    const operationTypes = mapOperationTypes(b.service_types);
    if (b.service_types.includes("catering_pickup")) {
      gaps.push(
        `Branch "${b.name}": service_types included "catering_pickup" — collapsed into "pickup" since there's no distinct catering-pickup fulfilment type; the catering menu's own lead-time/min-order rules aren't enforced anywhere regardless (see menu gaps).`,
      );
    }

    const branch = await service.createStoreBranch(store.id, {
      name: b.name,
      address: {
        street: b.address.line1,
        city: b.address.city,
        state: b.address.state,
      } as any,
      phone: b.phone || null,
      business_hours: businessHours as any,
      operation_types: operationTypes,
      prep_time_minutes: b.kitchen_avg_prep_minutes ?? 20,
      is_default: i === 0,
      is_active: true,
      tax_rate: b.tax_rate != null ? b.tax_rate * 100 : 0,
      manager: b.manager || null,
      format: b.format || null,
    } as any);
    branchIdMap.set(b.id, branch.id);
    console.log(`Branch created: ${branch.name} (${branch.id})`);

    const droppedFields: string[] = [];
    if (b.airport_surcharge_pct != null)
      droppedFields.push(`airport_surcharge_pct=${b.airport_surcharge_pct}`);
    if (b.seating) droppedFields.push("seating (table/floor management is a PRD non-goal)");
    if (droppedFields.length > 0) {
      gaps.push(`Branch "${b.name}": dropped fields with no equivalent — ${droppedFields.join(", ")}.`);
    }
  }

  // Delivery zones (zip-code-based per-branch fee/min-order/ETA tables) —
  // now a real, functioning feature (gap closed).
  let deliveryZoneCount = 0;
  for (const entry of json.delivery_zones || []) {
    const dbBranchId = branchIdMap.get(entry.branch_id);
    if (!dbBranchId) continue;
    for (const zone of entry.zones) {
      await service.createStoreDeliveryZone(store.id, {
        branch_id: dbBranchId,
        zip_code: zone.zip,
        fee: Math.round(zone.fee * 100),
        currency: "USD",
        min_order: zone.min_order != null ? Math.round(zone.min_order * 100) : null,
        estimated_minutes: zone.est_minutes ?? null,
      } as any);
      deliveryZoneCount++;
    }
  }
  if (deliveryZoneCount > 0) {
    console.log(`Delivery zones created: ${deliveryZoneCount}`);
  }

  // 3. Menus
  const menuIdMap = new Map<string, string>(); // json menu id -> db id
  const menuBranchesJsonMap = new Map<string, string[]>(); // json menu id -> json branch ids
  for (const m of json.menus) {
    const menuBranchIds = m.branches_available
      .map((id) => branchIdMap.get(id))
      .filter((id): id is string => !!id);
    const isAllBranches = menuBranchIds.length === branchIdMap.size;

    const menu = await service.createStoreMenu(store.id, {
      name: m.name,
      branch_ids: isAllBranches ? null : menuBranchIds,
    } as any);
    menuIdMap.set(m.id, menu.id);
    menuBranchesJsonMap.set(m.id, m.branches_available);
    console.log(`Menu created: ${menu.name} (${menu.id})`);

    const droppedFields: string[] = [];
    if (m.active_schedule) droppedFields.push(`active_schedule="${m.active_schedule}"`);
    if (m.requires_full_bar) droppedFields.push("requires_full_bar");
    if (m.min_order != null) droppedFields.push(`min_order=${m.min_order}`);
    if (m.lead_time_hours != null) droppedFields.push(`lead_time_hours=${m.lead_time_hours}`);
    if (droppedFields.length > 0) {
      gaps.push(
        `Menu "${m.name}": dropped fields with no equivalent — ${droppedFields.join(", ")}.`,
      );
    }
  }

  // 4. Categories — nominally scoped per (menu, category name) in the
  // source, since the same name (e.g. "Beverages") appears under more than
  // one menu. But category names are unique per STORE here (a
  // unique_store_category_slug constraint on (store_id, slug)), not per
  // menu — creating two "Beverages" categories in the same store fails.
  // Disambiguate repeats with the menu name in parens and log it.
  const categoryIdMap = new Map<string, string>(); // `${jsonMenuId}::${categoryName}` -> db id
  const categoryNamesUsed = new Set<string>();
  for (const m of json.menus) {
    const dbMenuId = menuIdMap.get(m.id)!;
    for (const catName of m.categories) {
      let effectiveName = catName;
      if (categoryNamesUsed.has(catName)) {
        effectiveName = `${catName} (${m.name})`;
        gaps.push(
          `Category "${catName}" under menu "${m.name}" renamed to "${effectiveName}" — category names must be unique per store (unique_store_category_slug constraint), not just per menu, so the same category name can't be reused across two menus as written in the source.`,
        );
      }
      categoryNamesUsed.add(catName);
      const created = await service.createStoreCategory(store.id, {
        name: effectiveName,
        menu_id: dbMenuId,
      } as any);
      categoryIdMap.set(`${m.id}::${catName}`, created.id);
      console.log(`  Category: ${effectiveName} (menu: ${m.name})`);
    }
  }

  // 5. Modifier groups (kind='modifier')
  const allBranchJsonIds = json.branches.map((b) => b.id);
  const modifierGroupIdMap = new Map<string, string>();
  for (const mg of json.modifier_groups) {
    const groupBranchIds = mg.branch_restricted_to?.length
      ? mg.branch_restricted_to.map((id) => branchIdMap.get(id)!).filter(Boolean)
      : null;

    const created = await service.createModifierGroup(store.id, {
      name: mg.name,
      selection_type: mg.selection_type,
      min_selections: mg.min_selections,
      max_selections: mg.max_selections,
      kind: "modifier",
      branch_ids: groupBranchIds,
    } as any);
    modifierGroupIdMap.set(mg.id, created.id);
    for (const opt of mg.options) {
      const optionBranchIds = opt.branch_exclude?.length
        ? allBranchJsonIds
            .filter((id) => !opt.branch_exclude!.includes(id))
            .map((id) => branchIdMap.get(id)!)
            .filter(Boolean)
        : null;
      await service.createModifierOption(store.id, created.id, {
        name: opt.name,
        price_delta: opt.price_delta,
        branch_ids: optionBranchIds,
      } as any);
    }
    console.log(`  Modifier group: ${mg.name} (${mg.options.length} options)`);
  }

  // 6. Add-ons (kind='addon') — one shared group, matching how the JSON
  // treats add_ons as a flat pool rather than per-item.
  let addonGroupId: string | null = null;
  if (json.add_ons.length > 0) {
    const addonGroup = await service.createModifierGroup(store.id, {
      name: "Extras",
      selection_type: "multiple",
      min_selections: 0,
      max_selections: null,
      kind: "addon",
    } as any);
    addonGroupId = addonGroup.id;
    for (const addon of json.add_ons) {
      await service.createModifierOption(store.id, addonGroup.id, {
        name: addon.name,
        price_delta: addon.price,
      } as any);
    }
    console.log(`  Add-on group: Extras (${json.add_ons.length} options)`);
    gaps.push(
      'add_ons had no per-item applicability in the source JSON, so all 7 (including catering-only ones like the chafing kit) were put in one "Extras" add-on group — attach/detach per item manually where it doesn\'t make sense (e.g. "Chafing Dish + Sterno Kit" on a single noodle bowl).',
    );
  }

  // 7. Items
  const overridesByItem = new Map<string, JsonBranchItemOverride[]>();
  for (const o of json.branch_item_overrides || []) {
    const list = overridesByItem.get(o.item_id) || [];
    list.push(o);
    overridesByItem.set(o.item_id, list);
  }

  let itemCount = 0;
  for (const item of json.items) {
    const categoryIds = item.menu_ids
      .map((menuId) => categoryIdMap.get(`${menuId}::${item.category}`))
      .filter((id): id is string => !!id);
    if (categoryIds.length === 0) {
      gaps.push(
        `Item "${item.name}": couldn't resolve any category for "${item.category}" under menus ${item.menu_ids.join(", ")} — skipped entirely.`,
      );
      continue;
    }

    // Availability = union of branches the item's menus are offered at,
    // minus any branch explicitly overridden to unavailable — now recorded
    // via branch_catalog_overrides (gap closed: real per-branch
    // availability + price, enforced at browsing and checkout time).
    const availableJsonBranchIds = new Set<string>();
    for (const menuId of item.menu_ids) {
      for (const b of menuBranchesJsonMap.get(menuId) || []) availableJsonBranchIds.add(b);
    }
    const overrides = overridesByItem.get(item.id) || [];
    const priceOverrideByBranch = new Map<string, number>();
    for (const o of overrides) {
      if (o.available === false) availableJsonBranchIds.delete(o.branch_id);
      if (o.price_override != null) priceOverrideByBranch.set(o.branch_id, o.price_override);
    }

    const descParts: string[] = [];
    if (item.allergens?.length) descParts.push(`Allergens: ${item.allergens.join(", ")}`);
    if (item.tags?.length) descParts.push(`Tags: ${item.tags.join(", ")}`);
    const description = descParts.join("\n");

    const usdPrice = item.base_price;
    const ngnPrice = Math.round(usdPrice * USD_TO_NGN_RATE);

    const product = await service.addProduct(
      store.id,
      {
        name: item.name,
        description,
        price: ngnPrice,
        currency_prices: { USD: { price: usdPrice, compare_at_price: null } },
        type: "physical",
        status: "published",
        cover_image: null,
        images: [],
        stock: null,
        category_ids: categoryIds,
        physical: { requires_shipping: false } as any,
        unit_of_sale: "piece",
        quantity_step: 1,
        min_order_quantity: 1,
        is_available_today: true,
        has_prep_time: true,
      } as any,
      userId,
      businessId,
    );

    for (const mgJsonId of item.modifier_groups) {
      const dbGroupId = modifierGroupIdMap.get(mgJsonId);
      if (dbGroupId) {
        await service.attachModifierGroupToProduct(store.id, product.id, dbGroupId);
      }
    }

    // Per-branch availability/price overrides — a row only for branches
    // that differ from "available everywhere, base price". Both the NGN
    // placeholder price and the authoritative currency_prices.USD are set,
    // mirroring how the base product price is split.
    const branchOverrides: Array<{
      branch_id: string;
      is_available: boolean;
      price: number | null;
      currency_prices?: Record<string, { price: number }> | null;
    }> = [];
    for (const b of json.branches) {
      const dbBranchId = branchIdMap.get(b.id)!;
      const isAvailable = availableJsonBranchIds.has(b.id);
      const priceOverrideUsd = priceOverrideByBranch.get(b.id);
      if (!isAvailable) {
        branchOverrides.push({ branch_id: dbBranchId, is_available: false, price: null });
      } else if (priceOverrideUsd != null) {
        branchOverrides.push({
          branch_id: dbBranchId,
          is_available: true,
          price: Math.round(priceOverrideUsd * USD_TO_NGN_RATE),
          currency_prices: { USD: { price: priceOverrideUsd } },
        });
      }
    }
    if (branchOverrides.length > 0) {
      await service.upsertProductBranchOverrides(store.id, product.id, branchOverrides);
    }

    itemCount++;
    console.log(`    Item: ${item.name} ($${usdPrice} / ₦${ngnPrice} placeholder)`);
  }

  if (json.combos?.length) {
    gaps.push(
      `Skipped ${json.combos.length} combos entirely, as agreed — they need conditional bundle logic ("any noodle bowl + half spring roll order + drink", "any large catering tray + platter + kit") that the current bundle product type doesn't support (bundles are just a fixed set of whole products at a discount).`,
    );
  }

  console.log("\n=== Import complete ===");
  console.log(`Store: ${store.name} (${store.slug})`);
  console.log(`Branches: ${branchIdMap.size}, Menus: ${menuIdMap.size}, Categories: ${categoryIdMap.size}`);
  console.log(
    `Modifier groups: ${modifierGroupIdMap.size} + ${addonGroupId ? 1 : 0} add-on group`,
  );
  console.log(`Items: ${itemCount}`);
  console.log(`\n=== Gaps (${gaps.length}) ===`);
  gaps.forEach((g, i) => console.log(`${i + 1}. ${g}`));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
