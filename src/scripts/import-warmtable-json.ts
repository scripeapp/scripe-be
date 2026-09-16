/**
 * One-off importer: takes the Warm Table Catering Co. JSON export (a
 * single-kitchen, event-catering business — pre-order-only, per-guest
 * package pricing, deposit-based booking) and creates a food store —
 * one branch (central kitchen), delivery zones, a menu, categories,
 * modifier groups/add-ons, and packages-as-products — using the real
 * StoreService methods (same validation/defaults the app itself uses,
 * just called directly instead of over HTTP).
 *
 * Structurally different from the restaurant-shaped kitchen JSONs this
 * family of scripts normally handles: no branches array (single central
 * kitchen), packages priced per-guest with a guest-count floor instead of
 * flat per-item prices, and a deposit/balance-due booking policy with no
 * platform equivalent (see gaps below).
 *
 * Usage:
 *   ts-node -r tsconfig-paths/register src/scripts/import-warmtable-json.ts <path-to-json> <business_id> <user_id>
 */
import "dotenv/config";
import * as fs from "fs";
import { supabaseAdmin } from "../config/supabase";
import { StoreService } from "../services/store.service";

interface JsonModifierOption {
  name: string;
  price_delta: number;
}
interface JsonModifierGroup {
  id: string;
  name: string;
  selection_type: "single" | "multiple";
  min_selections: number;
  max_selections: number | null;
  options: JsonModifierOption[];
}
interface JsonAddOn {
  id: string;
  name: string;
  price: number | null;
  pricing_note?: string;
}
interface JsonPricing {
  model: "per_guest" | "per_pack" | "per_tray";
  price_per_guest_ngn?: number;
  min_order_ngn?: number;
  base_price_ngn?: number;
}
interface JsonPackage {
  id: string;
  name: string;
  description: string;
  guest_range?: { min: number; max: number };
  components: string[];
  small_chops_subject_to_availability?: boolean;
  custom_addons_available?: boolean;
  exclusively_for_confirmed_catering_orders?: boolean;
  pricing: JsonPricing;
  modifier_groups: string[];
}
interface JsonCategory {
  id: string;
  name: string;
  items: JsonPackage[];
}
interface JsonZone {
  area: string;
  fee_ngn: number;
  est_setup_lead_minutes?: number;
}
interface WarmTableJson {
  business: {
    name: string;
    tagline?: string;
    city?: string;
    country?: string;
    central_kitchen_location?: string;
    contact?: { whatsapp_order_line?: string };
    service_types: string[];
    event_types_served?: string[];
    vat_rate?: number;
  };
  order_policy: {
    minimum_lead_time_hours?: number;
    deposit_required?: boolean;
    deposit_percentage?: number;
    balance_due?: string;
    cancellation_policy?: string;
  };
  delivery_pickup: { zones?: JsonZone[] };
  modifier_groups: JsonModifierGroup[];
  add_ons: { items: JsonAddOn[] };
  menu: { categories: JsonCategory[] };
}

const gaps: string[] = [];

const KNOWN_OPERATION_TYPES = ["dine_in", "pickup", "delivery", "curbside"] as const;
type OperationType = (typeof KNOWN_OPERATION_TYPES)[number];
// on_site_event_drop_off (delivery with on-site setup) has no distinct
// equivalent — collapsed into delivery, losing the "setup" distinction.
const SERVICE_TYPE_ALIASES: Record<string, OperationType> = {
  catering_delivery: "delivery",
  catering_pickup: "pickup",
  takeout: "pickup",
  on_site_event_drop_off: "delivery",
};

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
      "Usage: ts-node import-warmtable-json.ts <json-path> <business_id> <user_id>",
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const json: WarmTableJson = JSON.parse(raw);
  const service = new StoreService(supabaseAdmin);

  gaps.push(
    'Source data provenance: per the file\'s own note, only the business name/tagline/location/WhatsApp number/package names/dish lists come from a real flyer — all prices, the deposit percentage, lead-time, delivery zones/fees, and payment methods are synthetic Lagos-market placeholders ("assumed_placeholder": true) for testing. Replace with real figures before going live.',
  );

  // 1. Store
  const store = await service.createStore(userId, businessId, {
    name: json.business.name,
    sells_in_person: true,
  });
  console.log(`Store created: ${store.name} (${store.id}), slug=${store.slug}`);

  const eventTypesNote = json.business.event_types_served?.length
    ? `\nEvent types served: ${json.business.event_types_served.join(", ")}.`
    : "";
  await service.saveUserStore(
    userId,
    store.id,
    {
      appearance: {
        ...(store as any).appearance,
        description: `${json.business.tagline || ""}${eventTypesNote}`.trim(),
        contact_phone: json.business.contact?.whatsapp_order_line || "",
        location: [json.business.city, json.business.country].filter(Boolean).join(", "),
        social_links: {
          whatsapp: json.business.contact?.whatsapp_order_line || "",
        },
        policies: {
          privacy_policy: "",
          refund_policy: json.order_policy.cancellation_policy || "",
        },
      } as any,
    },
    businessId,
  );

  // 2. Branch — single central kitchen, no walk-in hours in the source
  // (WhatsApp-order-only business, nothing to lose by leaving hours null).
  const operationTypes = mapOperationTypes(json.business.service_types || []);
  const businessHours = {
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  };

  const branch = await service.createStoreBranch(store.id, {
    name: "Central Kitchen",
    address: {
      street: json.business.central_kitchen_location || "",
      city: json.business.city || "",
    } as any,
    phone: json.business.contact?.whatsapp_order_line || null,
    business_hours: businessHours as any,
    operation_types: operationTypes,
    is_default: true,
    is_active: true,
    tax_rate: json.business.vat_rate != null ? json.business.vat_rate * 100 : 0,
  } as any);
  console.log(`Branch created: ${branch.name} (${branch.id})`);

  // Delivery zones — area-name-keyed, same convention as prior imports.
  const zones = json.delivery_pickup.zones || [];
  for (const zone of zones) {
    await service.createStoreDeliveryZone(store.id, {
      branch_id: branch.id,
      zip_code: zone.area,
      fee: Math.round(zone.fee_ngn * 100),
      currency: "NGN",
      min_order: null,
      estimated_minutes: zone.est_setup_lead_minutes ?? null,
    } as any);
  }
  if (zones.length > 0) console.log(`Delivery zones created: ${zones.length}`);

  const orderPolicy = json.order_policy;
  if (orderPolicy.deposit_required) {
    gaps.push(
      `order_policy.deposit_required (${orderPolicy.deposit_percentage}% deposit, balance "${orderPolicy.balance_due}") skipped — checkout is a single full-payment flow with no deposit/split-payment or balance-due-later mechanism. The deposit/balance terms are noted in each package's description for the customer to read, but nothing is enforced or tracked at checkout.`,
    );
  }

  // 3. Menu + categories
  const menu = await service.createStoreMenu(store.id, { name: "Catering Menu" } as any);
  console.log(`Menu created: ${menu.name} (${menu.id})`);

  const categoryIdMap = new Map<string, string>();
  for (const cat of json.menu.categories) {
    const created = await service.createStoreCategory(store.id, {
      name: cat.name,
      menu_id: menu.id,
    } as any);
    categoryIdMap.set(cat.id, created.id);
    console.log(`  Category: ${cat.name}`);
  }

  // 4. Modifier groups (kind='modifier')
  const modifierGroupIdMap = new Map<string, string>();
  for (const mg of json.modifier_groups) {
    const created = await service.createModifierGroup(store.id, {
      name: mg.name,
      selection_type: mg.selection_type,
      min_selections: mg.min_selections,
      max_selections: mg.max_selections,
      kind: "modifier",
    } as any);
    modifierGroupIdMap.set(mg.id, created.id);
    for (const opt of mg.options) {
      await service.createModifierOption(store.id, created.id, {
        name: opt.name,
        price_delta: opt.price_delta,
      } as any);
    }
    console.log(`  Modifier group: ${mg.name} (${mg.options.length} options)`);
  }

  // 5. Add-ons — all are quote-on-request (price: null in the source), so
  // none can be represented as real modifier options (price_delta must be
  // a number). Skipped entirely rather than guessing a price.
  const quoteOnRequestAddOns = json.add_ons.items.filter((a) => a.price == null);
  if (quoteOnRequestAddOns.length > 0) {
    gaps.push(
      `${quoteOnRequestAddOns.length} add-on(s) skipped entirely — all are "quote provided on request via WhatsApp" with price: null in the source (${quoteOnRequestAddOns.map((a) => a.name).join(", ")}), and the add-on/modifier price model requires a fixed price_delta. These stay a manual WhatsApp back-and-forth, not an in-app add-on, until the business sets fixed prices.`,
    );
  }
  const pricedAddOns = json.add_ons.items.filter((a) => a.price != null);
  let addonGroupId: string | null = null;
  if (pricedAddOns.length > 0) {
    const addonGroup = await service.createModifierGroup(store.id, {
      name: "Extras",
      selection_type: "multiple",
      min_selections: 0,
      max_selections: null,
      kind: "addon",
    } as any);
    addonGroupId = addonGroup.id;
    for (const addon of pricedAddOns) {
      await service.createModifierOption(store.id, addonGroup.id, {
        name: addon.name,
        price_delta: addon.price as number,
      } as any);
    }
    console.log(`  Add-on group: Extras (${pricedAddOns.length} options)`);
  }

  // 6. Packages as products
  let itemCount = 0;
  for (const cat of json.menu.categories) {
    const categoryId = categoryIdMap.get(cat.id)!;
    for (const pkg of cat.items) {
      const descParts: string[] = [pkg.description];
      if (pkg.components?.length) descParts.push(`Includes: ${pkg.components.join("; ")}`);
      if (pkg.guest_range) {
        descParts.push(`Guest range: ${pkg.guest_range.min}-${pkg.guest_range.max}.`);
      }
      if (pkg.small_chops_subject_to_availability) {
        descParts.push("Small chops subject to availability.");
      }
      if (pkg.custom_addons_available) {
        descParts.push("Custom add-ons available on request via WhatsApp.");
      }
      if (pkg.exclusively_for_confirmed_catering_orders) {
        descParts.push("Available exclusively as an add-on to a confirmed catering order.");
      }
      if (orderPolicy.deposit_required) {
        descParts.push(
          `${orderPolicy.deposit_percentage}% deposit required to confirm booking; balance due ${orderPolicy.balance_due}.`,
        );
      }
      const description = descParts.filter(Boolean).join("\n");

      let price: number;
      let unitOfSale: string;
      let minOrderQuantity: number;
      if (pkg.pricing.model === "per_guest") {
        price = pkg.pricing.price_per_guest_ngn!;
        unitOfSale = "guest";
        minOrderQuantity = pkg.guest_range?.min ?? 1;
        if (pkg.guest_range?.max) {
          gaps.push(
            `Package "${pkg.name}": guest_range.max (${pkg.guest_range.max}) not enforced — no max-order-quantity field exists on products, only a minimum. A customer could order this package for far more guests than the package is designed for.`,
          );
        }
      } else {
        price = pkg.pricing.base_price_ngn!;
        unitOfSale = pkg.pricing.model.replace("per_", "");
        minOrderQuantity = 1;
      }

      const product = await service.addProduct(
        store.id,
        {
          name: pkg.name,
          description,
          price,
          type: "physical",
          status: "published",
          cover_image: null,
          images: [],
          stock: null,
          category_ids: [categoryId],
          lead_time_hours: orderPolicy.minimum_lead_time_hours ?? null,
          physical: { requires_shipping: false } as any,
          unit_of_sale: unitOfSale,
          quantity_step: 1,
          min_order_quantity: minOrderQuantity,
          is_available_today: true,
          has_prep_time: true,
        } as any,
        userId,
        businessId,
      );

      for (const mgJsonId of pkg.modifier_groups) {
        const dbGroupId = modifierGroupIdMap.get(mgJsonId);
        if (dbGroupId) {
          await service.attachModifierGroupToProduct(store.id, product.id, dbGroupId);
        }
      }

      itemCount++;
      console.log(`    Package: ${pkg.name} (₦${price}/${unitOfSale}, min ${minOrderQuantity})`);
    }
  }

  console.log("\n=== Import complete ===");
  console.log(`Store: ${store.name} (${store.slug})`);
  console.log(`Branch: 1, Menu: 1, Categories: ${categoryIdMap.size}`);
  console.log(
    `Modifier groups: ${modifierGroupIdMap.size} + ${addonGroupId ? 1 : 0} add-on group`,
  );
  console.log(`Packages: ${itemCount}`);
  console.log(`Delivery zones: ${zones.length}`);
  console.log(`\n=== Gaps (${gaps.length}) ===`);
  gaps.forEach((g, i) => console.log(`${i + 1}. ${g}`));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
