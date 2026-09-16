# Sisi Oge Food & Culture Weekend — seed gap report

Seeded by `src/scripts/import-sisioge-food-culture-event.ts` from the fixture
`sisi_oge_food_culture_weekend_event_test_data.json`, purely at the
service/API layer (`EventService.createEvent`, `PurchaseService.processCashPurchase`
— the same code the real `POST /api/events/create` and
`POST /api/dashboard/events/:id/orders/cash` routes call). No UI interaction.

Result: event `3a7b9492-6f85-4148-84b9-2e96a1de2d9b`
(`sisi-oge-food-culture-weekend`), status `draft`, store *Sisi Oge Kitchen &
Grill*, branch *Lekki Phase 1 Flagship*. 7 ticket tiers, 13 sessions across 3
days, 8 speakers, 2 real cash orders.

## What mapped cleanly

- Multi-day structure → `event_type: "multi_day"`, `event_sessions` (JSONB
  array, one entry per fixture session, flattened across the 3 agenda days).
- Speakers → `event_speakers` (JSONB array).
- 7 ticket tiers → 7 `event_tickets` rows.
- Venue, physical+online hybrid (`is_physical: true, is_online: true` — the
  livestream tier justifies both), multi-day date range.
- Registration deadline → `ticket_sales_end_date`/`ticket_sales_end_time`
  (closest existing field; semantically "no more purchases after this point,"
  which is what a registration deadline means in practice).

## Real gaps — no backend representation today

1. **No early-bird / regular / door pricing.** `event_tickets.ticket_price`
   is a single flat number. The pricing-rule engine
   (`src/utils/event-pricing.ts`) only has two condition evaluators —
   `segment_membership` and `coupon_code` — there is no date-conditioned rule
   type. Every ticket was seeded at its `regular_ngn` price; the fixture's
   `early_bird_ngn`/`door_price_ngn` figures are not stored or enforced
   anywhere. Confirmed live: the "weekend_pass" test purchase charged
   ₦26,000 (regular), not the ₦20,000 early-bird price the fixture's
   `test_evt_ord_0011` describes for a purchase made before the deadline.
   **To close this gap:** add a `date_range` (or `before`/`after`) condition
   type to the evaluator registry — the registry is explicitly designed for
   this ("new condition types … are added by registering one function").

2. **No add-on entity.** Nothing in the schema represents a purchasable item
   linked to a specific session with its own capacity pool (the fixture's
   `addon_masterclass_suya` / `addon_masterclass_swallow`, each with 12 total
   seats, 3 reserved for VIP, the rest sold separately). `event_tickets` is
   the only purchasable unit and it has no `linked_session_id` or
   parent/child relationship. The masterclass add-ons and the gift-bag
   upgrade could not be created at all — not as tickets, not as anything.
   The session data itself still carries `capacity`/`requires_addon` from the
   fixture, stored under each session's `_fixture_extra` key so the
   information isn't lost, but nothing reads or enforces it.

3. **No per-session ticket-tier inclusion.** The fixture's
   `included_in_tiers` (which tiers unlock which sessions) has no backend
   concept — `event_sessions` is a flat, informational agenda; a ticket tier
   doesn't reference which sessions it grants access to. Also preserved
   under `_fixture_extra` per session, unread by any current code.

4. **No age-gating.** Neither `events` nor `event_tickets` has an
   age-restriction field, and `PurchaseService.processCashPurchase` performs
   no age/ID check. The fixture's `test_evt_ord_0014_rejected` (17-year-old
   attempting to buy the 18+ Gala Dinner Only pass) was **not attempted** —
   a real call would have succeeded and issued the ticket. The gala's `18+`
   note lives only as prose in the event description now.

5. **No capacity check on the cash-purchase path.**
   `PurchaseService.processCashPurchase` → `updateTicketQuantities` calls
   the `increment_ticket_sold_quantity` RPC unconditionally; the RPC itself
   has no floor check (see `20260710_fix_ticket_quantity_sold.sql`) — it will
   happily decrement `available_quantity` below zero. The fixture's
   `test_evt_ord_0015` (VIP pass, sold out at 10/10, purchase should be
   rejected) was **not attempted** for the same reason: it would have
   succeeded and oversold the tier. The VIP tier was still seeded at exactly
   10/10 sold as a starting state (useful for testing "does the UI show sold
   out"), just not by executing a real rejected purchase.

6. **No event-level `currency` column.** `events` has no `currency` field at
   all (confirmed via live schema introspection — the insert fails with
   `PGRST204: Column 'currency' of relation 'events' does not exist` if you
   try). Currency is implicitly NGN by convention. `orders.currency` exists
   and does get set (to `"NGN"`) at purchase time, but there's no way to
   declare or query an event's currency up front.

7. **Everything else is prose, not data.** Refund policy, dress code,
   contact info, and the general age-restriction note have no dedicated
   event fields — they're folded into `event_description` as labeled
   sections so the information isn't dropped, but none of it is
   structured/queryable.

## Judgment calls made (flagging, not hiding)

- **`sold_so_far` counters are cosmetic**, not backed by real orders. Seeding
  ~360 individual fake orders to match the fixture's aggregate sale counts
  (31, 37, 22, 34, 10, 16, 212) was out of scope. Each ticket's
  `quantity_sold`/`available_quantity` was set directly to match
  `sold_so_far`/`capacity`, so the dashboard's numbers will match the
  fixture, but the **Attendees/Orders tabs will only show the 2 real cash
  orders** actually executed (Full Weekend Pass, Saturday Day Pass) — not
  360 attendees. Anyone using this event to test attendee lists, check-in
  flows, or per-order behavior at scale should be aware of that mismatch.
- **Session `type` values were remapped** to the frontend's strict
  `EventSession.session_type` union (`keynote | panel | workshop |
  presentation | break | networking | other`). `masterclass → workshop`,
  `talk → presentation`, `networking_reception → networking` are clean
  matches; `keynote_panel`, `live_competition`, `tasting_expo`, and
  `gala_dinner` don't map cleanly and were forced to their nearest bucket
  (`keynote`/`other`) with the original type appended to the session's
  description so it's not silently lost.
- **Status seeded as `draft`**, not `published` — this is fictional test
  data with a fake WhatsApp number and email domain; publishing it would
  make it publicly visible/purchasable on the storefront. Flip via the
  existing update endpoint when ready to go live.
- **Ticket purchase limits** (`ticket_purchase_limit`) aren't specified in
  the fixture at all; applied a generous default (10, or 2 for the
  exclusive VIP tier) rather than leaving the column unset.

## What would need to change to close the real gaps

In priority order (biggest fixture-vs-backend mismatch first):

1. Add a date-conditioned pricing-rule evaluator (early-bird/door pricing).
2. Add an add-on entity: a purchasable item linked to a specific
   `event_id` + optionally a session, with its own capacity pool
   independent of (and possibly carved out of) a linked session's total
   seats.
3. Add capacity validation to `PurchaseService.processCashPurchase` (and
   whatever the paid-checkout equivalent is) before incrementing
   `quantity_sold` — right now sold-out is purely a UI-level courtesy, not
   an enforced invariant.
4. Add an age-restriction field to `event_tickets` (or `events`, if it's
   meant to gate the whole event) and a checkout-time check.
5. If per-tier session access ever needs to be enforced (not just
   displayed), sessions need a way to reference which ticket tiers unlock
   them — today that's purely descriptive.
