# PRD: Food-Specific Store Onboarding & Experience

Status: **Superseded** — see [unified-store-model-prd.md](./unified-store-model-prd.md) (2026-07-29). The "General Store vs Food Store" branch this PRD proposed was decided against; store types are being deprecated in favor of one unified store with per-product capability flags. The food-specific requirements documented here (branches, menus, modifiers, prep time) are not discarded — they're re-scoped to product-level capabilities in the superseding PRD. Kept for historical reference.
Author: Claude (research pass), for review by Hilaq team
Related: [telegram-bot-architecture.md](./telegram-bot-architecture.md) (unrelated feature, same docs convention)
Prototype: an interactive mobile + web click-through validating the interaction patterns in §6.4 — https://claude.ai/code/artifact/d4427374-daf2-4fd9-be96-3cb60e3ca39d (private link tied to this session; reshare or rebuild as a team-accessible file before wider distribution). Reference for interaction behavior only, not final visual design.

## 1. Problem

Today "Create Store" produces one generic store type regardless of business. A restaurant, cafe, or food truck ends up with the same store as someone selling ebooks: single free-text location, one store-wide business-hours block, no branches, no walk-in/delivery distinction, and a product model with no concept of prep time, modifiers ("no onions", "extra cheese"), or perishability. Food businesses hit these gaps immediately — the store "breaks" for them not because of bugs, but because the model was never built for a business that operates out of multiple physical locations, takes both walk-in and delivery orders, and sells items that expire daily rather than sitting in inventory.

## 2. Goals

- Let a merchant choose **General Store** or **Food Store** at store-creation time, branching into a tailored onboarding.
- Support **branches** (multiple physical locations) under one food store, each with its own address, hours, and enabled operation types.
- Support **operation type** per branch: walk-in (counter/pickup) and/or delivery.
- Tailor the **customer-facing storefront** for food stores: branch selection, open/closed status, order-type toggle, menu-appropriate item display.
- Keep menu and category navigation **always discoverable** on the storefront — validated via prototype — rather than relying on a customer's scroll position to reveal what's available.
- Ship **device-appropriate interaction patterns** (sheet vs. dialog, full-screen vs. drawer, single-column vs. side-panel) rather than one mobile layout stretched to desktop.
- Ship incrementally — this PRD scopes the full picture but is meant to be broken into phases (§8).

## 3. Non-goals (for this phase)

- Dine-in table management / seating (walk-in here means "customer collects in person," not restaurant floor management).
- Real-time rider dispatch or route optimization — delivery fulfillment mechanics stay merchant-defined for now (see open question in §9).
- Nutrition/allergen compliance database — flagged as a future consideration, not required for v1 given Hilaq's current market.
- Migrating existing stores' data model — this only affects newly created food stores unless we decide to backfill.

## 4. Current state (audit summary)

Full detail available on request; key facts driving this design:

| Capability | Today |
|---|---|
| Store creation fields | `name` + `slug` only ([store.schemas.ts](../src/types/store.schemas.ts)) |
| Business → Store | Already 1-to-many (multi-store support shipped [20260103_multi_store_support.sql](../supabase/migrations/20260103_multi_store_support.sql)) |
| Store-level type/industry | Does not exist |
| Business-level category | Exists — "Food & Beverage" family (Restaurant, Cafe, Food Truck, Catering, Bakery, Other Food) already seeded in [20260115_add_business_categories.sql](../supabase/migrations/20260115_add_business_categories.sql) and shown in `CreateBusinessForm.tsx` — but purely cosmetic, doesn't branch any logic today |
| Branches/locations | Does not exist — `stores.appearance.location` is one free-text string |
| Business hours | One weekly schedule per store, not per branch |
| Delivery | `store_delivery_methods` = merchant-defined shipping options (e.g. "Express", price, ETA text) + optional Shipbubble courier integration. Assumes shipment, not walk-in pickup |
| Checkout | No fulfillment-type or branch selector — `initiateCheckout` only carries `delivery_method_id`/`delivery_fee`/`delivery_provider` |
| Product model | Generic type-discriminated schema (digital/physical/service/ebook/membership/bundle/donation). No prep time, modifiers, perishability, spice level |
| Menu structure | Flat only — `store_categories` is a single-level, per-store list ([migration](../supabase/migrations/20251231_create_store_categories.sql)), products attach to categories via a many-to-many `product_categories` join. **No "Menu" object above categories exists** — a merchant cannot create distinct named menus (e.g. Breakfast/Lunch/Catering), each with their own schedule or branch scoping |
| Reusable onboarding wizard | None — Store, Events, Circles, and Business onboarding are each bespoke step-state components; nothing to plug into, but also nothing to fight against |

**The one existing lever**: the business-level Food & Beverage category taxonomy. It's the right shape already (Restaurant/Cafe/Food Truck/Catering/Bakery/Other) — this PRD proposes promoting it from decorative metadata to an actual behavior trigger, rather than inventing a second taxonomy.

## 5. Industry reference points

Looked at how Toast, Uber Eats/Deliveroo, and Nigeria's Chowdeck handle this, to sanity-check scope:

- **Uber Eats/Toast onboarding** collects business name, location, license, and menu upfront, then treats pickup/delivery as a per-channel toggle the merchant can pause independently (e.g. throttle delivery during a rush while walk-in keeps flowing). This maps to our "operation type per branch" idea, with room to later add per-channel pause/throttle.
- **Chowdeck** (closest local comparable) verifies vendors via CAC registration, TIN, address, and banking details before granting full access, with a "limited access while pending" tier — relevant if Hilaq wants stronger verification for food merchants specifically (health/safety trust signal), though this may be over-scope for v1.
- **Multi-branch POS pattern**: centralize menu/pricing/roles at the business level, let hours/pricing/item availability vary per branch — matches Hilaq's existing business-level RBAC (`memberships`/`roles` already scoped to `business_id`, not `store_id`), so branch-level overrides should sit *under* the store, not require new permission plumbing.
- **Food-specific product needs** consistently cited: menu-style descriptions, modifier/add-on groups, dietary/allergen tags, prep-time-driven ETAs. Cold-chain/shipping concerns are largely irrelevant to Hilaq's walk-in/delivery model (that's for shippable packaged food, not made-to-order).

Sources: [Uber Eats Merchants](https://merchants.ubereats.com/us/en/services/delivery-pickup/), [Toast + Uber Eats integration](https://support.toasttab.com/en/article/Getting-Started-Uber-Eats-Integration), [Chowdeck vendor verification](https://help.chowdeck.com/en/articles/7984335-how-do-i-join-chowdeck-as-a-vendor), [multi-location POS patterns](https://cloudrestaurantmanager.com/restaurant-pos-systems-for-multi-location-operations/), [food e-commerce requirements](https://gfs.com/en-us/ideas/which-e-commerce-platform-best-your-restaurant/).

## 6. Proposed design

### 6.1 Store creation — the branch point

"Create Store" modal gains a first step: **Store Type** — `General Store` or `Food Store` (radio/card select, one-line description each). If the owning business's `sub_category_slug` is already one of the food ones (Restaurant/Cafe/Food Truck/Catering/Bakery/Other Food), pre-select Food Store but leave it changeable.

Chosen type is stored as `stores.store_type` (`'general' | 'food'`, default `'general'`, set once at creation). Treat as immutable post-creation for v1 — switching types later has cascading implications (branches, product schema, checkout) that deserve their own migration flow rather than an in-place toggle. (Flagged as an open question in §9 in case the team disagrees.)

### 6.2 Food onboarding steps (after selecting "Food Store")

1. **Basics** — name, slug (same as today).
2. **Cuisine/category** — reuse the existing business sub-category picker if not already set at the business level; otherwise let them pick per store (a business could plausibly run both a Bakery store and a separate Catering store).
3. **Branches** — at least one branch required before the store can go live. Per branch:
   - Name (e.g. "Ikeja Branch"), structured address (street/city/state + lat/lng for future distance-based features), phone.
   - Operating hours (per weekday open/close) — extend the existing `BusinessHoursSchema` shape to live per-branch instead of per-store.
   - Operation types enabled: Walk-in, Delivery, or both (checkboxes, at least one required).
   - Prep time (minutes) — default order-ready estimate, used for customer-facing ETA and internal order queue sorting.
   - Mark one branch "default" (used when a customer hasn't chosen one, or for single-branch stores where this UI mostly stays invisible).
4. **Menu setup** — merchant creates one or more named **Menus** (e.g. "Main Menu", "Breakfast", "Catering"), each containing its own categories and products, using the same product builder as today with food-aware additions (see 6.3). A store with simple needs just gets one default menu auto-created ("Main Menu") so this step stays invisible unless the merchant deliberately adds more.
5. **Review & launch** — same as current store creation completion.

Multi-branch UI should degrade gracefully for single-location merchants: one branch is created by default during onboarding (using the address/hours they already entered), and the branch-switcher UI simply doesn't render for a store with exactly one branch.

### 6.3 Data model changes

New table `store_branches`:
```
id, store_id (FK), name, address (jsonb: street/city/state/lat/lng),
phone, business_hours (jsonb, same shape as existing BusinessHoursSchema),
operation_types (text[]: 'walk_in' | 'delivery'), prep_time_minutes,
is_default (bool), is_active (bool), created_at, updated_at
```

`stores` table: add `store_type` (`'general' | 'food'`, default `'general'`).

`products` table (or a new `product_food_details` side-table to avoid bloating the generic schema further): add, gated by `store_type = 'food'`:
- `prep_time_minutes` (nullable override of branch default)
- `is_available_today` (fast toggle for "sold out" without touching stock counts)
- `available_branch_ids` (which branches carry this item — supports different menus per branch)

**Modifier groups — reusable, not per-product.** The pattern to build for (confirmed by how competitor apps like the Taco Kit / Burrito example actually work): the same option set (e.g. "Proteins": Shredded Chicken +₦5,000, Goat +₦6,000, Grilled Beef +₦8,000...) repeats identically across multiple menu items. Re-entering that per product doesn't scale, so modifier groups live at the store level and get *attached* to products, not created fresh each time:

```
modifier_groups: id, store_id (FK), name, selection_type ('single' | 'multiple'),
  min_selections (int, default 0), max_selections (int, nullable = unlimited),
  position, created_at, updated_at

modifier_options: id, modifier_group_id (FK), name, price_delta (numeric, default 0),
  is_available (bool, default true — "86" a sold-out option without deleting it),
  is_default (bool — pre-selected, e.g. a default "no ice" toggle), position

product_modifier_groups: product_id (FK), modifier_group_id (FK), position
  -- junction table: a product attaches whichever groups apply to it
  -- (Taco Kit attaches "Proteins"; Burrito attaches the same "Proteins" group + its own "Salsas")
```

`min_selections`/`max_selections` directly express what the screenshots show ("Max 3", "Required" = `min_selections >= 1`). `selection_type` drives checkbox (multiple) vs. radio (single) rendering. This is the food-specific sibling of the existing generic `ProductVariantSchema` — kept as a separate system because modifiers are attach-many/reusable and often free-form price deltas, whereas variants are more rigid SKU-defining choices (size/color).

**Per-item note.** Cart line items get a free-text `note` field (the "Add Note" button in the reference screenshots) — independent of modifiers, passed straight through to the merchant's order/kitchen view. Cheap to add, no schema complexity: just a nullable string per cart item.

**Checkout line item shape**, extending today's `{product_id, variant_id, quantity, price}` (`store.schemas.ts:289-299`):
```
{ product_id, variant_id?, quantity, price?,
  selected_modifiers: [{ modifier_option_id, quantity? }],  // new
  note?: string }                                            // new
```

**Selling by unit (liters/kg) — not food-exclusive.** Separate gap: today `quantity` is integer-only (`z.number().int().positive()`, `store.schemas.ts:296`) and price is a flat per-item amount — there's no way to sell soup by the liter or oil by the kg where price scales with a fractional quantity. This isn't specific to food (a general store selling fabric by the yard has the identical need), so it's proposed as a generic product capability rather than something gated to `store_type = 'food'`:
- `products.unit_of_sale` (enum or free string: `piece | liter | kg | pack | yard | ...`, default `'piece'`)
- `products.quantity_step` (numeric, default `1` — e.g. `0.5` for half-liter increments)
- `products.min_order_quantity` (numeric, default `1`)
- Checkout schema: relax `quantity` to `z.number().positive()` (decimal-capable), validated against the product's `quantity_step`/`min_order_quantity` at the service layer rather than a hardcoded integer constraint.
- Storefront quantity control switches from a +/- integer stepper to a step-aware input (e.g. 0.5 increments) and displays the unit label ("1.5 L", "2 kg") instead of a bare count.

**Menu entity** (new, gated to `store_type = 'food'`): merchants today can only build one flat list of categories per store — there's no way to group categories into a distinct, named, manageable "Menu." This PRD adds a real two-level hierarchy:

```
store_menus: id, store_id (FK), name, description, position,
  availability (jsonb, optional — same shape as BusinessHoursSchema, null = always available),
  branch_ids (uuid[], optional — null/empty = available at all branches),
  is_active (bool), created_at, updated_at
```

`store_categories` gains a `menu_id` FK (nullable during migration, required going forward for food stores). Products keep attaching to categories exactly as today via the existing `product_categories` join — the change is purely that categories now belong to a menu, not directly to the bare store. This lets a merchant have a "Breakfast Menu" (6–11am, all branches) and a separate "Catering Menu" (no schedule, one branch only, or hidden from the default storefront and shared via direct link) as distinct, duplicable objects — matching how Toast/Square model multi-menu restaurants, and how merchants themselves think about the concept ("my menus," not "my categories"). A store with one simple menu just gets a single auto-created "Main Menu" wrapping all its categories, so this is invisible complexity unless the merchant opts into more.

Checkout: extend `initiateCheckout` schema with `fulfillment_type` (`'walk_in' | 'delivery'`) and `branch_id`. Cart should be constrained to a single branch per order (surface this early — e.g. disable "add to cart" or prompt to clear cart if switching branches mid-session).

### 6.4 Customer-facing storefront differences

For `store_type = 'food'` only — additive, General Store keeps its current experience untouched. Everything below was built and clicked through in the interactive prototype (see link at top of doc) before being written up here, so this reflects validated interaction behavior, not a first guess.

**Navigation & discoverability.** An early review concern: if categories only exist as section headers a customer scrolls past, they're effectively hidden until the customer happens to scroll there. The fix, prototyped on both surfaces:
- **Menu** (the department-level pick — Breakfast/Lunch/Catering) is a **compact switcher** — one pill/dropdown control — not a prominent tab strip. A tab strip for Menu would otherwise occupy the storefront's prime real estate and push Category navigation down into "scroll to discover it" territory, which is exactly the problem being solved.
- **Category** navigation takes that freed-up space instead, as a **sticky chip rail synced to scroll position** — the active chip highlights as the customer scrolls past that category's section, and tapping a chip jumps straight to it. Categories are now always visible, never just discoverable by accident.
- On **web**, the same split maps onto existing chrome: the sidebar becomes the Menu switcher (department-level — mirrors how a grocery app's sidebar picks the aisle), and the sticky chip row sits above the item grid for Category sub-navigation (mirrors the aisle's subcategory pills). Deliberately borrowed: the *navigational skeleton* (persistent switcher + scroll-synced sticky sub-nav). Deliberately **not** borrowed: retail-catalog chrome — stock-count labels, sale-price tags, star-rating counts, dense uniform grids with "View more" pagination. A curated, appetite-driven menu of a few dozen items isn't a multi-department grocery catalog, and that chrome would read as retail cosplay rather than a menu.

**Store identity header.** Replaces a tall hero-banner treatment with a compact **business info card** — small banner thumbnail, logo, name, address, one-line description — sitting near the top rather than dominating the screen. The address line reflects the *currently selected branch*, not a generic business address, and updates live if the customer switches branches — branch selection is the closest equivalent to a single-location shopping context.

**Device-appropriate modal patterns** — prototyped rather than assumed:
- **Item detail**: full-screen sheet on mobile; a centered dialog (image-left, details-right, over a dimmed backdrop) on web — matching how competitor food-ordering dialogs actually render on desktop.
- **Cart & fulfillment**: full-screen on mobile; a right-side slide-over drawer on web, keeping the storefront visible behind it since desktop has width to spare.
- **Order tracking**: full-screen timeline on mobile; a dedicated page on web with a persistent order-summary panel beside the timeline. (The prototype's "delivery route" panel there — dots and a dashed line — is illustrative chrome only, not a live map or GPS integration; real-time rider tracking stays out of scope per §3.)

**Fulfillment & status.**
- **Branch selector** shown up top if more than one branch; hidden entirely for single-branch stores.
- **Open/Closed badge** derived from the selected branch's `business_hours`.
- **Order type toggle** — "Pickup" vs "Delivery" — filtered to only the operation types the selected branch actually supports. Selecting Delivery reveals an address field and a fee line; selecting Pickup shows the branch address/instructions instead, and drops the fee entirely rather than showing ₦0.
- Each item's detail view shows prep time, its attached modifier groups (radio for single-select, checkboxes for multi-select, `min`/`max` enforced client-side before "Add" is enabled), a free-text note field, and a running total that updates live as modifiers/quantity change.
- **Unit-aware quantity control** — for products with a non-default `unit_of_sale`, the quantity control becomes a step-aware input (respecting `quantity_step`/`min_order_quantity`) showing the unit ("1.5 L") instead of a plain integer stepper.
- **Order status language** — prep-oriented (Received → Preparing → Ready for Pickup / Out for Delivery → Completed), not shipping-oriented — no carrier, no tracking number, because nothing is being shipped.

## 7. What does NOT change for General Store

Everything in §6 is gated behind `store_type = 'food'`. General Store keeps today's exact flow: name + slug creation, single location string, one business-hours block, existing product types and checkout. No regression risk to the existing 99% of stores.

## 8. Suggested phasing

1. **Phase 1 — Foundation**: `store_type` field + store-type picker in Create Store modal; `store_branches` table + CRUD + dashboard UI (address, hours, operation types, prep time); default single-branch auto-creation for merchants who skip multi-branch setup.
2. **Phase 2 — Menu**: `store_menus` table + CRUD (auto-create one default "Main Menu" per food store so this is invisible until a merchant wants more), `menu_id` added to `store_categories`, food-specific product metadata (prep time override, availability toggle), reusable `modifier_groups`/`modifier_options` + `product_modifier_groups` attachment UI, per-item note field, wired into the existing `ProductBuilder`/`ProductTypeForms` as a new food-aware form path. `unit_of_sale`/`quantity_step` can ship independently of the rest of this phase since it's a generic product capability, not food-gated — worth doing whenever convenient, possibly even before Phase 1 if a general-store merchant need surfaces first.
3. **Phase 3 — Storefront**: business info card header, compact Menu switcher + sticky scroll-synced Category chip rail (mobile) / sidebar-Menu + chip-row-Category split (web), branch selector, open/closed badge, pickup/delivery toggle, device-appropriate item-detail and cart patterns (sheet/drawer on mobile, dialog/slide-over on web), prep-oriented order status on the public storefront and order tracking pages.
4. **Phase 4 — Checkout plumbing**: `fulfillment_type` + `branch_id` on checkout, single-branch cart constraint, branch-scoped order queue for merchants (so a branch only sees its own incoming orders).

Each phase is independently shippable and testable; Phase 1 alone already lets food merchants describe their business accurately even before menu/storefront catches up.

## 9. Open questions for review

1. **Store type mutability** — should a merchant be able to convert General ↔ Food after creation, or is this a one-way choice made at creation (proposed default: immutable for v1)?
2. **Delivery fulfillment model** — should food-store delivery ride on the existing carrier/Shipbubble integration (built for parcel shipment), or be simpler and merchant-fulfilled (e.g. "we deliver ourselves, no tracking integration") given prep-time/hot-food constraints don't fit courier-shipment assumptions well?
3. ~~**Inventory scope**~~ — **decided**: global product/variant stock remains the fallback, with sparse product- or variant-level branch balances in `branch_inventory_overrides`; see [Branch inventory overrides](./branch-inventory-overrides.md).
4. ~~Modifier reusability~~ — **decided**: modifier groups are reusable store-level objects attached to products via a junction table (§6.3), matching how competitor apps actually behave (identical "Proteins" group repeated across Taco Kit and Burrito). Follow-on question: if a product needs to *exclude* one option from an otherwise-shared group (e.g. Burrito can't do "Veggie/Vegan" but Taco Kit can), do we support per-attachment overrides in v1, or require the merchant to create a near-duplicate group? Recommend deferring per-attachment overrides — start with whole-group attach/detach only, revisit if merchants hit this wall.
5. **Verification bar for food merchants** — does Hilaq want Chowdeck-style stronger verification (CAC/TIN) specifically for Food Store type, or is this out of scope for now and left to existing business-level verification?
6. **Cleanup alongside this work** — two separate `CreateStoreModal.tsx` implementations exist ([Dashboard/CreateStoreModal.tsx](../../surge-fe/src/components/Dashboard/CreateStoreModal.tsx) — active; [Dashboard/Store/CreateStoreModal.tsx](../../surge-fe/src/components/Dashboard/Store/CreateStoreModal.tsx) — unclear if still mounted). Worth confirming and removing the dead one while touching this code.
7. **Menu-level permissions** — decided: food stores get a real `store_menus` entity (§6.3) rather than staying flat-category. Follow-on question: should menu management (create/edit/delete a menu) require a distinct permission from general `store.settings.create`/product management, or ride on existing store-level roles? Given `memberships`/`roles` are business-scoped today, the likely answer is "no new permission needed," but worth confirming since it's a merchant-facing structural object, not just a setting.
8. **Per-modifier-option quantity** — can a customer select "2x Extra Cheese," or is each option pick-once-only (the reference screenshots show plain checkboxes, implying pick-once)? Proposed default: pick-once for v1 (`selected_modifiers` still carries an optional `quantity` in the schema for future-proofing, but UI only exposes checkbox/radio, not a per-option stepper).
9. **`unit_of_sale` scope** — proposed as a generic product capability rather than food-gated (§6.3) since it applies equally to a general store selling by the yard/ml. Confirm the team agrees it shouldn't be bundled as "food-only" scope, since that affects prioritization relative to the rest of this PRD.
10. **Chip rail / scroll-spy priority** — is the sticky, scroll-synced Category chip rail (§6.4) core to the Phase 3 storefront release, or can a simpler static category list ship first with the sticky/scroll-spy behavior as a fast-follow polish pass? Recommend treating it as core given how directly it resolves the discoverability concern that prompted this exploration — but flagging since it adds moderate frontend complexity (scroll-position-driven state) relative to a plain list.

## 10. Success criteria (draft — refine with team)

- A food merchant can create a store, add 2+ branches with distinct hours/operation types, and build one or more named menus with categories, products, and modifiers, without needing manual/support intervention.
- A merchant running distinct menus (e.g. Breakfast vs. Catering) can schedule and branch-scope each independently, and customers see only the currently-active menu(s) for their selected branch.
- Customers on a multi-branch food storefront can pick a branch, see accurate open/closed status, and complete a walk-in or delivery order end to end.
- Categories and menus stay discoverable throughout a browsing session — findable via persistent, scroll-synced navigation, not only by scrolling until you happen to land on them.
- Item detail, cart, and order tracking each use the interaction pattern appropriate to the device (sheet/dialog, full-screen/drawer, single-column/side-panel) rather than a single layout stretched across screen sizes.
- Zero behavior change for existing General Store merchants.
