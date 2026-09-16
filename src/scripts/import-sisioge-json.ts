/**
 * One-off importer: takes the Sisi Oge Kitchen & Grill multi-branch JSON
 * export (Lagos, NGN-native) and creates a food store — branches (tax
 * rate, dine-in-only service charge, manager/format), delivery zones
 * (area-name-keyed), menus (branch-scoped), categories, modifier groups/
 * options (branch-scoped/excluded), add-ons, and items (with per-branch
 * price/availability overrides and lead-time enforcement) — using the
 * real StoreService methods (same validation/defaults the app itself
 * uses, just called directly instead of over HTTP).
 *
 * Same shape as import-spiceroute-json.ts (brand/branches/menus/
 * modifier_groups/add_ons/items/branch_item_overrides/combos/
 * delivery_zones), but NGN-native (no FX placeholder needed — item prices
 * are used directly), "takeaway" instead of "pickup" in service_types,
 * and a single flat service_charge_rate per branch (applied to dine-in
 * only, per the source's own sample orders) instead of a per-fulfilment
 * map.
 *
 * Branch-aware fields (menu.branch_ids, modifier_group/option.branch_ids,
 * branch_catalog_overrides, store_delivery_zones, branch tax_rate/
 * service_charge_rates/manager/format, product.lead_time_hours) require
 * the 20260722_*, 20260723_*, and 20260724_* migrations to be applied
 * first — see supabase/migrations/.
 *
 * Usage:
 *   ts-node -r tsconfig-paths/register src/scripts/import-sisioge-json.ts <path-to-json> <business_id> <user_id>
 */
import "dotenv/config";
import * as fs from "fs";
import { supabaseAdmin } from "../config/supabase";
import { StoreService } from "../services/store.service";

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
  note?: string;
  default?: string;
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
  code?: string;
  format?: string;
  address: { line1: string; city: string; state: string };
  phone?: string;
  timezone?: string;
  seating?: unknown;
  service_types: string[];
  vat_rate?: number;
  service_charge_rate?: number;
  airport_surcharge_pct?: number;
  power_supply_note?: string;
  hours: Record<string, string>;
  menus_available: string[];
  kitchen_avg_prep_minutes?: number;
  manager?: string;
  notes?: string;
}
interface JsonMenu {
  id: string;
  name: string;
  type?: string;
  active_schedule?: string;
  branches_available: string[];
  categories: string[];
  note?: string;
}
interface JsonItem {
  id: string;
  name: string;
  category: string;
  menu_ids: string[];
  base_price: number;
  unit?: string;
  availability_note?: string;
  eaten_by_hand?: boolean;
  lead_time_hours?: number;
  allergens?: string[];
  tags?: string[];
  modifier_groups: string[];
}
interface JsonBranchItemOverride {
  branch_id: string;
  item_id: string;
  price_override?: number;
  available?: boolean;
  modifier_override?: Record<string, unknown>;
  reason?: string;
}
interface JsonDeliveryZoneEntry {
  branch_id: string;
  zones: Array<{
    area: string;
    fee_ngn: number;
    min_order_ngn?: number;
    est_minutes_off_peak?: number;
  }>;
}
interface SisiOgeJson {
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

const HOUR_GROUPS: Record<string, string[]> = {
  mon_thu: ["monday", "tuesday", "wednesday", "thursday"],
  fri_sat: ["friday", "saturday"],
  sun: ["sunday"],
  mon_fri: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  sat_sun: ["saturday", "sunday"],
  daily: [...WEEKDAYS],
  mon_sat: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  sat: ["saturday"],
};

// Handles 24h "10:00-22:00" style ranges and strips a trailing parenthetical
// note (none in this source, but kept for robustness) or a bare "closed".
function parseTimeToken(raw: string): string | null {
  const h24 = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (h24) return `${h24[1].padStart(2, "0")}:${h24[2]}`;
  return null;
}
function parseRange(raw: string): { open: string; close: string } | null {
  if (/closed/i.test(raw)) return null;
  const withoutNote = raw.replace(/\([^)]*\)/g, "").trim();
  const parts = withoutNote.split("-").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const open = parseTimeToken(parts[0]);
  const close = parseTimeToken(parts[1]);
  if (!open || !close) return null;
  return { open, close };
}

function buildBusinessHours(
  hours: Record<string, string>,
): Record<string, { open: string; close: string } | null> {
  const result: Record<string, { open: string; close: string } | null> = {};
  WEEKDAYS.forEach((d) => (result[d] = null));
  for (const [key, raw] of Object.entries(hours)) {
    if (/closed/i.test(raw)) continue; // already null
    const days = HOUR_GROUPS[key];
    if (!days) {
      gaps.push(`Unrecognised hours group key "${key}" (value "${raw}") — skipped.`);
      continue;
    }
    const range = parseRange(raw);
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
const SERVICE_TYPE_ALIASES: Record<string, OperationType> = { takeaway: "pickup", takeout: "pickup" };

function mapOperationTypes(serviceTypes: string[]): OperationType[] {
  const normalised = serviceTypes.map((t) => SERVICE_TYPE_ALIASES[t] || t);
  const mapped = Array.from(
    new Set(
      normalised.filter((t): t is OperationType =>
        (KNOWN_OPERATION_TYPES as readonly string[]).includes(t),
      ),
    ),
  );
  const unknown = normalised.filter(
    (t) => !(KNOWN_OPERATION_TYPES as readonly string[]).includes(t),
  );
  if (unknown.length > 0) {
    gaps.push(`service_types included unrecognised value(s): ${unknown.join(", ")} — dropped.`);
  }
  if (mapped.length === 0) mapped.push("pickup");
  return mapped;
}

async function main() {
  const [, , jsonPath, businessId, userId] = process.argv;
  if (!jsonPath || !businessId || !userId) {
    console.error(
      "Usage: ts-node import-sisioge-json.ts <json-path> <business_id> <user_id>",
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const json: SisiOgeJson = JSON.parse(raw);
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
    },
    businessId,
  );

  if (json.brand.loyalty_program) {
    gaps.push(
      `brand.loyalty_program ("${(json.brand.loyalty_program as any).name}" — points-per-naira, tiers, redemption rate) skipped entirely — no points/rewards/loyalty system exists anywhere in the store data model.`,
    );
  }

  // 2. Branches
  const branchIdMap = new Map<string, string>();
  for (const [i, b] of json.branches.entries()) {
    const businessHours = buildBusinessHours(b.hours);
    const operationTypes = mapOperationTypes(b.service_types);

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
      tax_rate: b.vat_rate != null ? b.vat_rate * 100 : 0,
      // Source models one flat rate per branch; its own sample orders
      // confirm it's dine-in-only ("Not applied - delivery orders exempt
      // from dine-in service charge"), so mapped to just the dine_in key.
      service_charge_rates:
        b.service_charge_rate != null ? { dine_in: b.service_charge_rate * 100 } : null,
      manager: b.manager || null,
      format: b.format || null,
    } as any);
    branchIdMap.set(b.id, branch.id);
    console.log(`Branch created: ${branch.name} (${branch.id})`);

    const droppedFields: string[] = [];
    if (b.code) droppedFields.push(`code="${b.code}" (no internal branch-code field)`);
    if (b.timezone) droppedFields.push(`timezone="${b.timezone}" (platform assumes a single store-wide timezone)`);
    if (b.airport_surcharge_pct != null)
      droppedFields.push(`airport_surcharge_pct=${b.airport_surcharge_pct}`);
    if (b.power_supply_note) droppedFields.push("power_supply_note (informational only)");
    if (b.notes) droppedFields.push(`notes="${b.notes}"`);
    if (b.seating) droppedFields.push("seating (table/floor management is a PRD non-goal)");
    if (droppedFields.length > 0) {
      gaps.push(`Branch "${b.name}": dropped fields with no equivalent — ${droppedFields.join(", ")}.`);
    }
  }

  // Delivery zones — area-name-keyed (not real zip codes), stored as-is in
  // the zip_code field since matching is just an exact string lookup.
  let deliveryZoneCount = 0;
  for (const entry of json.delivery_zones || []) {
    const dbBranchId = branchIdMap.get(entry.branch_id);
    if (!dbBranchId) continue;
    for (const zone of entry.zones) {
      await service.createStoreDeliveryZone(store.id, {
        branch_id: dbBranchId,
        zip_code: zone.area,
        fee: Math.round(zone.fee_ngn * 100),
        currency: "NGN",
        min_order: zone.min_order_ngn != null ? Math.round(zone.min_order_ngn * 100) : null,
        estimated_minutes: zone.est_minutes_off_peak ?? null,
      } as any);
      deliveryZoneCount++;
    }
  }
  if (deliveryZoneCount > 0) {
    console.log(`Delivery zones created: ${deliveryZoneCount}`);
  }

  // 3. Menus
  const menuIdMap = new Map<string, string>();
  const menuBranchesJsonMap = new Map<string, string[]>();
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
    if (m.type) droppedFields.push(`type="${m.type}" (informational categorisation only)`);
    if (m.active_schedule) droppedFields.push(`active_schedule="${m.active_schedule}"`);
    if (m.note) droppedFields.push(`note="${m.note}"`);
    if (droppedFields.length > 0) {
      gaps.push(`Menu "${m.name}": dropped fields with no equivalent — ${droppedFields.join(", ")}.`);
    }
  }

  // 4. Categories — unique per store, not per menu (see Spice Route import
  // for the full explanation) — disambiguate repeats with the menu name.
  const categoryIdMap = new Map<string, string>();
  const categoryNamesUsed = new Set<string>();
  for (const m of json.menus) {
    const dbMenuId = menuIdMap.get(m.id)!;
    for (const catName of m.categories) {
      let effectiveName = catName;
      if (categoryNamesUsed.has(catName)) {
        effectiveName = `${catName} (${m.name})`;
        gaps.push(
          `Category "${catName}" under menu "${m.name}" renamed to "${effectiveName}" — category names must be unique per store, not just per menu.`,
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
      description: mg.note || null,
      branch_ids: groupBranchIds,
    } as any);
    modifierGroupIdMap.set(mg.id, created.id);
    if (mg.default) {
      gaps.push(
        `Modifier group "${mg.name}": default-selected option "${mg.default}" skipped — modifier groups have no default/pre-selected option field, customers must choose explicitly.`,
      );
    }
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

  // 6. Add-ons (kind='addon') — one shared group.
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
      `add_ons had no per-item applicability in the source JSON, so all ${json.add_ons.length} were put in one "Extras" add-on group — attach/detach per item manually where it doesn't make sense (e.g. "Chafing Dish + Sterno Kit" on a single lunch box).`,
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

    const availableJsonBranchIds = new Set<string>();
    for (const menuId of item.menu_ids) {
      for (const b of menuBranchesJsonMap.get(menuId) || []) availableJsonBranchIds.add(b);
    }
    const overrides = overridesByItem.get(item.id) || [];
    const priceOverrideByBranch = new Map<string, number>();
    for (const o of overrides) {
      if (o.available === false) availableJsonBranchIds.delete(o.branch_id);
      if (o.price_override != null) priceOverrideByBranch.set(o.branch_id, o.price_override);
      if (o.modifier_override) {
        gaps.push(
          `Item "${item.name}" at branch ${o.branch_id}: per-branch modifier_override (${JSON.stringify(o.modifier_override)}) skipped — lead_time_hours and other product fields are store-wide, not branch-scoped, so this branch-specific override (e.g. a longer lead time at a smaller kitchen) can't be represented. The item's base value applies at every branch.`,
        );
      }
    }

    const descParts: string[] = [];
    if (item.unit) descParts.push(`Unit: ${item.unit}`);
    if (item.availability_note) descParts.push(`Availability: ${item.availability_note}`);
    if (item.eaten_by_hand) descParts.push("Traditionally eaten by hand.");
    if (item.allergens?.length) descParts.push(`Allergens: ${item.allergens.join(", ")}`);
    if (item.tags?.length) descParts.push(`Tags: ${item.tags.join(", ")}`);
    const description = descParts.join("\n");

    const product = await service.addProduct(
      store.id,
      {
        name: item.name,
        description,
        price: item.base_price,
        type: "physical",
        status: "published",
        cover_image: null,
        images: [],
        stock: null,
        category_ids: categoryIds,
        lead_time_hours: item.lead_time_hours ?? null,
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

    const branchOverrides: Array<{
      branch_id: string;
      is_available: boolean;
      price: number | null;
    }> = [];
    for (const b of json.branches) {
      const dbBranchId = branchIdMap.get(b.id)!;
      const isAvailable = availableJsonBranchIds.has(b.id);
      const priceOverride = priceOverrideByBranch.get(b.id);
      if (!isAvailable) {
        branchOverrides.push({ branch_id: dbBranchId, is_available: false, price: null });
      } else if (priceOverride != null) {
        branchOverrides.push({ branch_id: dbBranchId, is_available: true, price: priceOverride });
      }
    }
    if (branchOverrides.length > 0) {
      await service.upsertProductBranchOverrides(store.id, product.id, branchOverrides);
    }

    itemCount++;
    console.log(
      `    Item: ${item.name} (₦${item.base_price})${item.lead_time_hours ? ` [${item.lead_time_hours}h lead time]` : ""}`,
    );
  }

  if (json.combos?.length) {
    gaps.push(
      `Skipped ${json.combos.length} combos entirely, as agreed — they need conditional bundle logic (e.g. "any of 3 lunch box types x5", modifier preselection, age-gating for the beer combo, day/time-window availability) that the current bundle product type doesn't support.`,
    );
  }

  console.log("\n=== Import complete ===");
  console.log(`Store: ${store.name} (${store.slug})`);
  console.log(`Branches: ${branchIdMap.size}, Menus: ${menuIdMap.size}, Categories: ${categoryIdMap.size}`);
  console.log(
    `Modifier groups: ${modifierGroupIdMap.size} + ${addonGroupId ? 1 : 0} add-on group`,
  );
  console.log(`Items: ${itemCount}`);
  console.log(`Delivery zones: ${deliveryZoneCount}`);
  console.log(`\n=== Gaps (${gaps.length}) ===`);
  gaps.forEach((g, i) => console.log(`${i + 1}. ${g}`));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
