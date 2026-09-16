/**
 * Provisions a full food store from a structured "kitchen JSON" — the
 * server-side port of scripts/import-kitchen-json.ts's main() body. Same
 * StoreService call sequence, with gaps collected per-call (not
 * module-level) and returned instead of logged. The import script is now
 * a thin argv wrapper around this function, so rerunning it against a
 * known JSON doubles as the port's regression test.
 */
import { SupabaseClient } from "@supabase/supabase-js";
import { StoreService } from "../store.service";
import { KitchenJson } from "../../types/ai-agent.types";

export interface ProvisionResult {
  storeId: string;
  storeName: string;
  slug: string;
  counts: {
    branches: number;
    menus: number;
    categories: number;
    modifierGroups: number;
    addonGroups: number;
    items: number;
    deliveryZones: number;
  };
  gaps: string[];
}

export type ProvisionProgress = (step: string) => void;

// Handles both "11:00 AM - 2:00 PM" (12h) and "10:00 - 22:00" (24h) styles,
// and strips a trailing parenthetical note like "(after-church rush...)".
function parseTimeToken(raw: string): string | null {
  const trimmed = raw.trim();
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let hour = parseInt(ampm[1], 10);
    const minute = ampm[2];
    const meridian = ampm[3].toUpperCase();
    if (meridian === "PM" && hour !== 12) hour += 12;
    if (meridian === "AM" && hour === 12) hour = 0;
    return `${hour.toString().padStart(2, "0")}:${minute}`;
  }
  const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) return `${h24[1].padStart(2, "0")}:${h24[2]}`;
  return null;
}

function parseRange(raw: string): { open: string; close: string } | null {
  const withoutNote = raw.replace(/\([^)]*\)/g, "").trim();
  const parts = withoutNote.split("-").map((p) => p.trim());
  if (parts.length < 2) return null;
  const open = parseTimeToken(parts[0]);
  const close = parseTimeToken(parts[1]);
  if (!open || !close) return null;
  return { open, close };
}

export async function provisionStoreFromKitchenJson(
  supabase: SupabaseClient,
  json: KitchenJson,
  userId: string,
  businessId: string,
  onProgress?: ProvisionProgress,
): Promise<ProvisionResult> {
  const service = new StoreService(supabase);
  const progress = onProgress ?? (() => {});

  // 1. Store
  progress("Creating store");
  const store = await service.createStore(userId, businessId, {
    name: json.restaurant.name,
    sells_in_person: true,
  });

  await service.saveUserStore(
    userId,
    store.id,
    {
      appearance: {
        ...(store as any).appearance,
        description: json.restaurant.description,
      } as any,
    },
    businessId,
  );

  // Everything else writes rows that all cascade from stores.id (verified
  // against every migration this function touches), so on any failure from
  // here on, deleting the store is enough to clean up branch/menu/
  // categories/modifiers/items too — see the try/catch around this call.
  try {
    return await provisionStoreEntities(service, store, json, userId, businessId, progress);
  } catch (err) {
    try {
      await supabase.from("stores").delete().eq("id", store.id);
    } catch (cleanupErr) {
      // Never let a cleanup failure mask the real error — just log it. A
      // leftover store here still needs the same manual cleanup this whole
      // change is meant to avoid, but at least the merchant sees the real
      // failure reason instead of a silently swallowed one.
      console.error(
        "[provisionStoreFromKitchenJson] cleanup of failed store also failed:",
        cleanupErr,
      );
    }
    throw err;
  }
}

async function provisionStoreEntities(
  service: StoreService,
  store: { id: string; name: string; slug: string },
  json: KitchenJson,
  userId: string,
  businessId: string,
  progress: ProvisionProgress,
): Promise<ProvisionResult> {
  const gaps: string[] = [];

  // 2. Branch
  progress("Setting up branch");
  const businessHours: Record<
    string,
    { open: string; close: string } | null
  > = {
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  };
  const hours = json.restaurant.hours || {};
  const monThu = hours.mon_thu ? parseRange(hours.mon_thu) : null;
  const friSat = hours.fri_sat ? parseRange(hours.fri_sat) : null;
  const sun = hours.sun ? parseRange(hours.sun) : null;
  if (monThu) {
    businessHours.monday = monThu;
    businessHours.tuesday = monThu;
    businessHours.wednesday = monThu;
    businessHours.thursday = monThu;
  }
  if (friSat) {
    businessHours.friday = friSat;
    businessHours.saturday = friSat;
  }
  if (sun) businessHours.sunday = sun;
  // Also honour per-day keys (monday..sunday) if the extraction emits them.
  const DAY_KEYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  for (const day of DAY_KEYS) {
    if (hours[day]) {
      const range = parseRange(hours[day]);
      if (range) businessHours[day] = range;
    }
  }
  for (const [key, raw] of Object.entries(hours)) {
    if (/\([^)]*\)/.test(raw)) {
      gaps.push(
        `Hours entry "${key}: ${raw}" had a note in brackets — only one open/close range per day is supported, so the note was dropped.`,
      );
    }
  }

  const serviceTypes = json.restaurant.service_types || [];
  const KNOWN_OPERATION_TYPES = [
    "dine_in",
    "pickup",
    "delivery",
    "curbside",
  ] as const;
  type OperationType = (typeof KNOWN_OPERATION_TYPES)[number];
  const SERVICE_TYPE_ALIASES: Record<string, OperationType> = {
    takeaway: "pickup",
    takeout: "pickup",
    catering_pickup: "pickup",
    catering_delivery: "delivery",
  };
  const normalisedServiceTypes = serviceTypes.map(
    (t) => SERVICE_TYPE_ALIASES[t] || t,
  );
  const operationTypes: OperationType[] = Array.from(
    new Set(
      normalisedServiceTypes.filter((t): t is OperationType =>
        (KNOWN_OPERATION_TYPES as readonly string[]).includes(t),
      ),
    ),
  );
  const unknownServiceTypes = normalisedServiceTypes.filter(
    (t) => !(KNOWN_OPERATION_TYPES as readonly string[]).includes(t),
  );
  if (unknownServiceTypes.length > 0) {
    gaps.push(
      `Some service types weren't recognised and were skipped: ${unknownServiceTypes.join(", ")}.`,
    );
  }
  if (operationTypes.length === 0) operationTypes.push("pickup");

  // vat_rate/tax_rate are fractions (0.075 = 7.5%) in the source; the
  // platform's branch tax_rate column is a percentage (7.5).
  const vatRate = json.restaurant.vat_rate ?? json.restaurant.tax_rate ?? null;

  const branch = await service.createStoreBranch(store.id, {
    name: json.restaurant.name,
    address: {
      street: json.restaurant.address.line1,
      city: json.restaurant.address.city,
      state: json.restaurant.address.state,
    } as any,
    phone: json.restaurant.phone || null,
    business_hours: businessHours as any,
    operation_types: operationTypes,
    is_default: true,
    is_active: true,
    tax_rate: vatRate != null ? vatRate * 100 : 0,
  } as any);

  if (!json.restaurant.address.line1 || !json.restaurant.address.city) {
    gaps.push(
      "The branch address is incomplete — fill in the street/city under Store → Branches.",
    );
  }
  if (Object.keys(hours).length === 0) {
    gaps.push(
      "No opening hours were found — set them under Store → Branches.",
    );
  }

  // Delivery zones — the platform's zone-matching field is named
  // "zip_code" but is an exact string match, so neighbourhood names are
  // stored there as-is (Nigerian addresses rarely use zip codes).
  progress("Adding delivery zones");
  const deliveryZones = json.restaurant.delivery?.zones || [];
  for (const zone of deliveryZones) {
    await service.createStoreDeliveryZone(store.id, {
      branch_id: branch.id,
      zip_code: zone.area,
      fee: Math.round(zone.fee_ngn * 100),
      currency: "NGN",
      min_order:
        zone.min_order_ngn != null
          ? Math.round(zone.min_order_ngn * 100)
          : null,
      estimated_minutes: zone.est_minutes_off_peak ?? null,
    } as any);
  }

  // 3. Menu
  progress("Creating menu");
  const menu = await service.createStoreMenu(store.id, {
    name: "Main Menu",
  } as any);

  // 4. Categories — store_categories has a UNIQUE(store_id, name)
  // constraint, and a fresh store starts with none, so an extraction that
  // ever emits two categories with the same name would otherwise throw
  // here. Dedupe defensively rather than trust the LLM's output is unique.
  const categoryIdMap = new Map<string, string>();
  const usedCategoryNames = new Set<string>();
  for (const cat of json.menu.categories) {
    let name = cat.name;
    let suffix = 2;
    while (usedCategoryNames.has(name.toLowerCase())) {
      name = `${cat.name} (${suffix})`;
      suffix++;
    }
    usedCategoryNames.add(name.toLowerCase());

    const created = await service.createStoreCategory(store.id, {
      name,
      menu_id: menu.id,
    } as any);
    categoryIdMap.set(cat.id, created.id);
  }

  // 5. Modifier groups (kind='modifier')
  progress("Creating modifiers");
  const modifierGroupIdMap = new Map<string, string>();
  for (const mg of json.modifier_groups) {
    const created = await service.createModifierGroup(store.id, {
      name: mg.name,
      selection_type: mg.selection_type,
      min_selections: mg.min_selections,
      max_selections: mg.max_selections,
      kind: "modifier",
      description: mg.note || null,
    } as any);
    modifierGroupIdMap.set(mg.id, created.id);
    for (const opt of mg.options) {
      await service.createModifierOption(store.id, created.id, {
        name: opt.name,
        price_delta: opt.price_delta,
      } as any);
    }
  }

  // 6. Add-ons (kind='addon') — one shared group, matching how the JSON
  // treats add_ons as a flat store-wide pool rather than per-item.
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
    gaps.push(
      `All ${json.add_ons.length} add-ons were grouped into one "Extras" group — detach any that don't fit specific items.`,
    );
  }

  // 7. Items
  progress("Adding menu items");
  const leadTimeItems: string[] = [];
  let itemCount = 0;
  for (const cat of json.menu.categories) {
    const categoryId = categoryIdMap.get(cat.id)!;
    for (const item of cat.items) {
      const descParts = [item.description];
      if (item.unit) descParts.push(`Unit: ${item.unit}`);
      if (item.price_note) descParts.push(`Note: ${item.price_note}`);
      if (item.availability_note)
        descParts.push(`Availability: ${item.availability_note}`);
      if (item.eaten_by_hand) descParts.push("Traditionally eaten by hand.");
      if (item.calories != null) descParts.push(`Calories: ${item.calories}`);
      if (item.allergens?.length)
        descParts.push(`Allergens: ${item.allergens.join(", ")}`);
      if (item.tags?.length) descParts.push(`Tags: ${item.tags.join(", ")}`);
      const description = descParts.filter(Boolean).join("\n");

      if (item.lead_time_hours != null) {
        leadTimeItems.push(`${item.name} (${item.lead_time_hours}h)`);
      }

      const product = await service.addProduct(
        store.id,
        {
          name: item.name,
          description,
          price: item.price,
          type: "physical",
          status: "published",
          cover_image: null,
          images: [],
          stock: null,
          category_ids: [categoryId],
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
          await service.attachModifierGroupToProduct(
            store.id,
            product.id,
            dbGroupId,
          );
        }
      }

      itemCount++;
    }
  }
  if (leadTimeItems.length > 0) {
    gaps.push(
      `${leadTimeItems.length} item(s) mention advance ordering (${leadTimeItems.join(", ")}) — no lead-time is enforced at checkout yet.`,
    );
  }

  return {
    storeId: store.id,
    storeName: store.name,
    slug: store.slug,
    counts: {
      branches: 1,
      menus: 1,
      categories: categoryIdMap.size,
      modifierGroups: modifierGroupIdMap.size,
      addonGroups: addonGroupId ? 1 : 0,
      items: itemCount,
      deliveryZones: deliveryZones.length,
    },
    gaps,
  };
}
