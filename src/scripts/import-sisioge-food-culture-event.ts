/**
 * One-off importer: seeds the "Sisi Oge Food & Culture Weekend" fictional
 * multi-day event (see the sisi_oge_food_culture_weekend_event_test_data.json
 * fixture) into the existing Sisi Oge Kitchen & Grill store, purely at the
 * API/service layer — no browser/UI interaction.
 *
 * Calls the exact same service methods the real API routes call:
 *   - EventService.createEvent()               (POST /api/events/create)
 *   - PurchaseService.processCashPurchase()     (POST /api/dashboard/events/:id/orders/cash)
 * so this doubles as a smoke test of those code paths, matching the
 * convention already established by import-kitchen-json.ts.
 *
 * Several concepts in the source fixture have no backend representation
 * today (early-bird/door pricing, per-session add-ons with reserved-seat
 * carve-outs, age-gated checkout). Rather than fake them, this script maps
 * what's representable and prints an explicit gap report at the end —
 * see also docs/sisi-oge-event-seed-gaps.md written alongside this script.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/import-sisioge-food-culture-event.ts <path-to-json>
 */
import "dotenv/config";
import * as fs from "fs";
import { supabaseAdmin } from "../config/supabase";
import { EventService } from "../services/events.services";
import { createPurchaseService } from "../services/purchase.service";

const SISI_OGE_STORE_NAME = "Sisi Oge Kitchen & Grill";
const LEKKI_BRANCH_NAME = "Lekki Phase 1 Flagship";

// session_type values allowed by the frontend's strict EventSession union
// (src/utils/types.ts). The fixture uses a richer, more specific vocabulary,
// so we map down to the closest match and keep the original type visible in
// the description rather than silently losing it.
const SESSION_TYPE_MAP: Record<string, string> = {
  keynote_panel: "keynote",
  panel: "panel",
  talk: "presentation",
  networking_reception: "networking",
  masterclass: "workshop",
  live_competition: "other",
  tasting_expo: "other",
  gala_dinner: "other",
};

function mapSessionType(raw: string): string {
  return SESSION_TYPE_MAP[raw] ?? "other";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

async function findStoreContext() {
  const { data: store, error: storeErr } = await supabaseAdmin
    .from("stores")
    .select("id, name, business_id, slug")
    .ilike("name", `%${SISI_OGE_STORE_NAME}%`)
    .single();
  if (storeErr || !store) {
    throw new Error(
      `Could not find store "${SISI_OGE_STORE_NAME}": ${storeErr?.message ?? "not found"}`,
    );
  }

  const { data: business, error: bizErr } = await supabaseAdmin
    .from("businesses")
    .select("id, name, owner_user_id")
    .eq("id", store.business_id)
    .single();
  if (bizErr || !business) {
    throw new Error(`Could not load business for store: ${bizErr?.message}`);
  }

  const { data: branches, error: branchErr } = await supabaseAdmin
    .from("store_branches")
    .select("id, name, address")
    .eq("store_id", store.id)
    .ilike("name", `%${LEKKI_BRANCH_NAME}%`);
  if (branchErr || !branches || branches.length === 0) {
    throw new Error(
      `Could not find branch "${LEKKI_BRANCH_NAME}" for store ${store.id}: ${branchErr?.message ?? "not found"}`,
    );
  }

  return {
    storeId: store.id as string,
    businessId: business.id as string,
    ownerUserId: business.owner_user_id as string,
    branchId: branches[0].id as string,
    branchAddress: branches[0].address as {
      street?: string;
      city?: string;
      state?: string;
    },
  };
}

function buildEventSpeakers(fixture: any) {
  return (fixture.speakers ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    bio: s.bio,
  }));
}

function buildEventSessions(fixture: any, speakersById: Map<string, any>) {
  const sessions: any[] = [];
  for (const day of fixture.agenda ?? []) {
    for (const s of day.sessions ?? []) {
      const mappedType = mapSessionType(s.type);
      const lossy = mappedType !== s.type && !["talk", "panel"].includes(s.type);
      sessions.push({
        id: s.id,
        title: s.title,
        description: lossy
          ? `${s.description ?? ""} (original session type: ${s.type})`.trim()
          : s.description ?? "",
        session_type: mappedType,
        date: day.date,
        start_time: s.start_time,
        end_time: s.end_time,
        location: s.track,
        speakers: (s.speakers ?? []).map((id: string) => ({
          speaker: speakersById.get(id) ?? { id, name: id },
          role: "speaker",
        })),
        // Not part of the frontend's strict EventSession type and not
        // rendered by the current dashboard UI — kept here so the richer
        // fixture data (capacity carve-outs, tier inclusion, VIP perks,
        // age gates) isn't silently discarded. See gap report.
        _fixture_extra: {
          capacity: s.capacity,
          requires_addon: s.requires_addon,
          included_in_tiers: s.included_in_tiers,
          vip_perk: s.vip_perk,
          age_restriction: s.age_restriction,
          requires_id_check: s.requires_id_check,
          note: s.note ?? s.included_in_tiers_note,
        },
      });
    }
  }
  return sessions;
}

function buildDescription(fixture: any): string {
  const e = fixture.event;
  const parts = [
    e.tagline,
    "",
    e.description,
    "",
    `Refund policy: ${e.refund_policy}`,
    `Age restrictions: ${e.age_restriction_note}`,
    `Dress code: ${e.dress_code}`,
    `Contact: ${e.contact?.whatsapp ?? ""} · ${e.contact?.email ?? ""}`,
  ];
  return parts.join("\n");
}

// Tiers whose sample_ticket_purchases entry is a real, backend-representable
// cash sale (no add-on, no age gate, no capacity-block scenario) get exactly
// one live purchase through PurchaseService — see the gap report for why the
// other three sample_ticket_purchases entries are documented, not executed.
const LIVE_PURCHASE_TIER_IDS = new Set(["weekend_pass", "day_pass_sat"]);

async function main() {
  const jsonPath =
    process.argv[2] ??
    "/Users/nombauser/Library/Application Support/Claude/local-agent-mode-sessions/c9bce996-f277-4d01-bef6-870028373d74/acc329ca-f02d-4f67-9c77-3e9fa120f826/local_2ab20364-4f25-4491-9604-0aae3352c8c9/outputs/sisi_oge_food_culture_weekend_event_test_data.json";

  const fixture = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const ctx = await findStoreContext();

  console.log(`Store: ${SISI_OGE_STORE_NAME} (${ctx.storeId})`);
  console.log(`Business: ${ctx.businessId}, owner: ${ctx.ownerUserId}`);
  console.log(`Branch: ${LEKKI_BRANCH_NAME} (${ctx.branchId})`);

  const speakers = buildEventSpeakers(fixture);
  const speakersById = new Map<string, any>(
    speakers.map((s: any) => [s.id, s]),
  );
  const sessions = buildEventSessions(fixture, speakersById);

  const e = fixture.event;
  const eventUrl = slugify(e.name);

  // sold_so_far in the fixture is a historical snapshot, not backed by real
  // orders — see gap report. Applied here as the ticket's starting counter.
  // The two tiers with a live sample purchase below are seeded one unit
  // short so that purchase lands the counter exactly on sold_so_far.
  const tickets = (fixture.ticket_tiers ?? []).map((tier: any) => {
    const isLimited = tier.capacity != null;
    const soldSoFar = tier.sold_so_far ?? 0;
    const preSeat = LIVE_PURCHASE_TIER_IDS.has(tier.id)
      ? Math.max(0, soldSoFar - 1)
      : soldSoFar;
    return {
      ticket_type: "paid",
      ticket_name: tier.name,
      ticket_is_limited_stock: isLimited,
      // available_quantity is *remaining* stock, not capacity — the
      // increment_ticket_sold_quantity RPC decrements it on every real sale
      // (see 20260710_fix_ticket_quantity_sold.sql), and the public
      // checkout page's sold-out check is `available_quantity === 0`
      // (TicketItem.tsx), not a quantity_sold/capacity comparison. Seeding
      // it as the full capacity regardless of the pre-seeded sold count
      // was a real bug in an earlier version of this script — caught by
      // manually tracing the public checkout's sold-out logic against a
      // supposedly sold-out VIP tier, which it did NOT treat as sold out.
      available_quantity: isLimited ? Math.max(0, tier.capacity - preSeat) : 0,
      // No date-conditioned pricing exists backend-side — regular_ngn is
      // the only price that can be enforced automatically. See gap report.
      ticket_price: tier.pricing.regular_ngn,
      ticket_purchase_limit: tier.id === "vip_pass" ? 2 : 10,
      quantity_sold: preSeat,
      user_id: ctx.ownerUserId,
      _fixture_tier_id: tier.id, // stripped before insert, kept for lookup below
    };
  });

  const eventPayload = {
    owner_id: ctx.ownerUserId,
    event_name: e.name,
    event_description: buildDescription(fixture),
    is_physical: true,
    is_online: true, // virtual_pass tier livestreams the main-stage sessions
    event_url: eventUrl,
    venue: {
      placeDesc: e.venue.name,
      placeId: ctx.branchId,
      full_address: e.venue.address,
    },
    language: "english",
    platform_name: "",
    platform_url: "",
    event_type: "multi_day",
    event_sessions: sessions,
    event_speakers: speakers,
    status: "draft", // seeded fixture data; flip to "published" when ready
    timezone: "UTC+01:00 West Central Africa",
    start_date: e.dates.start,
    start_time: fixture.agenda[0].sessions[0].start_time,
    end_date: e.dates.end,
    end_time:
      fixture.agenda[fixture.agenda.length - 1].sessions[
        fixture.agenda[fixture.agenda.length - 1].sessions.length - 1
      ].end_time,
    // No currency column on events — see gap report; pricing is NGN by
    // convention (matches the fixture and every ticket's implicit currency).
    ticket_sales_start_date: null,
    tickets_sales_start_immediately: true,
    ticket_sales_end_date: e.registration_deadline.slice(0, 10),
    ticket_sales_end_time: e.registration_deadline.slice(11, 19),
    fee_payer: "attendee",
    sales_channels: ["storefront"],
    checkout_fields: [],
    pricing_rules: [], // no date-conditioned rule type exists — see gap report
    confirmation_email: null,
    tickets: tickets.map(({ _fixture_tier_id, ...t }: any) => t),
  };

  const eventService = new EventService(supabaseAdmin as any);
  const created = await eventService.createEvent(eventPayload, ctx.businessId, {
    actorUserId: ctx.ownerUserId,
  });

  console.log(`\n=== Event created ===`);
  console.log(`id: ${created.id}`);
  console.log(`event_url: ${created.event_url}`);
  console.log(`tickets created: ${created.tickets.length}`);

  const ticketIdByTierId = new Map<string, string>();
  created.tickets.forEach((t: any) => {
    const tierId = tickets.find(
      (raw: any) => raw.ticket_name === t.ticket_name,
    )?._fixture_tier_id;
    if (tierId) ticketIdByTierId.set(tierId, t.id);
  });

  // Execute the two sample_ticket_purchases entries that are honestly
  // representable as real cash orders (see LIVE_PURCHASE_TIER_IDS comment).
  const purchaseService = createPurchaseService(supabaseAdmin as any);
  const purchaseResults: any[] = [];

  const weekendTicketId = ticketIdByTierId.get("weekend_pass");
  if (weekendTicketId) {
    const result = await purchaseService.processCashPurchase({
      event_id: created.id,
      customer_name: "Adaeze Nwankwo",
      customer_email: "adaeze.nwankwo@example.test",
      customer_phone: "+2348021234567",
      customer_gender: "female",
      ticket_id: weekendTicketId,
      quantity: 1,
      check_in_immediately: false,
    });
    purchaseResults.push({ tier: "weekend_pass (test_evt_ord_0011 analogue)", ...result });
  }

  const satDayTicketId = ticketIdByTierId.get("day_pass_sat");
  if (satDayTicketId) {
    const result = await purchaseService.processCashPurchase({
      event_id: created.id,
      customer_name: "Walk-up Attendee",
      customer_email: "",
      customer_phone: "",
      customer_gender: "",
      ticket_id: satDayTicketId,
      quantity: 1,
      check_in_immediately: false,
    });
    purchaseResults.push({ tier: "day_pass_sat (test_evt_ord_0012 analogue)", ...result });
  }

  console.log(`\n=== Sample purchases executed (${purchaseResults.length}) ===`);
  purchaseResults.forEach((r) =>
    console.log(`${r.tier}: order ${r.order_id}, ref ${r.payment_reference}`),
  );

  console.log(`\n=== NOT executed (no backend support — see gap report) ===`);
  console.log(
    "- test_evt_ord_0011's masterclass add-on (addon_masterclass_suya): no add-on entity exists",
  );
  console.log(
    "- test_evt_ord_0013_rejected (sold-out add-on rejection): no add-on entity, nothing to reject",
  );
  console.log(
    "- test_evt_ord_0014_rejected (age-gated gala_only_pass, 17-year-old): no age-check exists; a real call would have succeeded",
  );
  console.log(
    "- test_evt_ord_0015 (vip_pass tier-sold-out rejection): no capacity check exists on the cash-purchase path; a real call would have succeeded and oversold the tier",
  );

  console.log(`\nDone. Draft event ready at /dashboard/store/product/${created.id}?kind=event`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
