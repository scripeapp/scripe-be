# PRD: Unified Store Model (Deprecating Store-Type Differentiation)

Status: **Draft for review** — no implementation yet
Author: Claude (session synthesis), for review by Hilaq team
Supersedes: [food-store-onboarding-prd.md](./food-store-onboarding-prd.md) — that PRD proposed branching store creation into "General Store" / "Food Store" at signup. This PRD reverses that direction per the decision in §1. Kept in the repo for historical context on the food-specific feature requirements (branches, menus, modifiers, prep time) it documented — those requirements aren't discarded, just re-homed from store-type to product-capability (§3).

## 1. Decision & source

Hilaq will not maintain distinct store "types" (General, Food, or any future category chosen at store creation). There will be **one store model** that supports every capability Hilaq offers; a merchant decides which capabilities apply to them, rather than picking a category upfront that locks them into a feature set.

> "Actually, no it is not [relevant]. It's just going to be one single store and everything we support will be there and you'll just decide to use it or not... The differentiation will come under type of product you are creating."
> — Abdullahi (Bro Abodunrin), 2026-07-29, in response to Abdulsalam asking whether general/food store types are still relevant for the next phase.

## 2. Problem

The current model hard-codes a binary `store_type` (`general` | `food`) at the database, schema, and UI layers ([store.ts:1045](../src/types/store.ts), [store.schemas.ts:924](../src/types/store.schemas.ts), [migration](../supabase/migrations/20260720_add_food_store_branches.sql)). This binary:

- **Doesn't scale.** The immediate goal is to support digital-only sellers, general retail, restaurants, *and* pharmacies on the same platform. A two-value enum can't represent a pharmacy (physical + regulated + expiry-tracked) without becoming a third hardcoded bucket, and the next merchant type after that becomes a fourth, and so on.
- **Locks features to a category instead of a need.** Branches, in the current model, only exist for `food` stores ([CreateStoreModal.tsx:47-55](../../surge-fe/src/components/Dashboard/CreateStore/CreateStoreModal.tsx)). But multi-location is a need that belongs to any merchant with more than one outlet — a pharmacy chain or a retail chain wants it just as much as a restaurant.
- **Forces a decision too early.** A merchant picks a type once, at onboarding, before they've necessarily decided what they're selling — and the product catalog is where the actual differentiation (digital vs. physical vs. prepared vs. regulated) naturally lives anyway.

## 3. Resolution (decided this session)

Four architectural forks were identified from the codebase audit (§5) and resolved as follows:

### 3.1 Physical presence: explicit store-level toggle
`sells_in_person` (already shipped, [migration](../supabase/migrations/20260805_store_sells_in_person.sql)) becomes the **only** signal for "this merchant has an in-person side." The current `hasPhysicalLocation()` helper — `store_type === 'food' || sells_in_person` ([store.ts:634-638](../../surge-fe/src/types/store.ts)) — drops the `store_type` half entirely. Every merchant, regardless of what they sell, flips this on/off once. It is not inferred from the catalog, to keep store-level UI (branches, registers, POS) stable and predictable rather than appearing/disappearing as products are added or removed.

### 3.2 Product differentiation: composable capability flags, not a type enum
The thing that actually needs to vary per product — shipping fields, prep-time/kitchen assignment, digital delivery, regulated-goods handling — moves onto the **product**, as a set of independent boolean/enum capabilities rather than a closed "product type" list:

| Flag | Meaning | Example |
|---|---|---|
| `requires_shipping` | Needs physical fulfillment/delivery address | Retail goods, pharmacy items |
| `digital_delivery` | Delivered as a file/link/access grant on purchase | Ebooks, digital products, memberships |
| `has_prep_time` | Needs a prep workflow, kitchen/station/branch assignment | Restaurant dishes |
| `age_restricted` | Requires age verification at checkout | *(schema only this phase — see 3.4)* |
| `license_required` | Requires prescription/license verification | *(schema only this phase)* |
| `expiry_tracked` | Batch/expiry-date inventory tracking | *(schema only this phase)* |

A digital book carries only `digital_delivery`. A restaurant dish carries `has_prep_time` (and not `requires_shipping`). A pharmacy item eventually carries `requires_shipping`, `expiry_tracked`, `license_required` together. No product needs a bucket that doesn't fit it, and adding a new merchant vertical later means adding a flag, not a migration that touches every existing store.

### 3.3 Branches: universal module, decoupled from product capabilities
Multi-location support becomes a store-level module any merchant can enable, independent of what they sell or whether `sells_in_person` is on. It is removed from the food-only step list in `CreateStoreModal.tsx` and re-homed under the module-registry opt-in pattern described in §3.5.

### 3.4 Pharmacy / regulated-goods compliance: deferred, schema-only
This phase adds the `age_restricted`, `license_required`, and `expiry_tracked` capability flags to the product schema (so pharmacy data has a place to live) but ships **no** enforcement — no prescription upload flow, no checkout age-gate, no regulatory logic. Building that is a separate future PRD, written once there's a real pharmacy merchant to design against rather than speculatively.

### 3.5 `module-registry.service` is the actual "decide to use it or not" mechanism
The audit found `module-registry.service` does **not** currently gate on `store_type` — it's already an unused lever for exactly the opt-in model the decision describes. Branches, in-person selling/POS, and (once built) regulated-goods handling should all become entries a merchant opts into there, rather than side effects of a category chosen at signup. This is the mechanism that makes "everything we support will be there and you'll decide to use it or not" literally true, rather than aspirational.

## 4. Goals

- Remove `store_type` as a concept from store creation, storage, and all UI branches.
- Let a merchant enable in-person selling, multi-branch, and (future) regulated-goods handling independently, at any time, via module opt-in rather than a one-time category choice.
- Move all product-creation branching (shipping, prep time, digital delivery) from `store.store_type` to per-product capability flags.
- Support, on day one of this phase: digital-only sellers, general physical retail, and restaurants under one store model with no category wall between them.
- Lay the schema groundwork for pharmacy/regulated goods without building enforcement yet.

## 5. Non-goals (this phase)

- Prescription verification, age-gated checkout, or any regulated-goods enforcement UI (§3.4).
- Redesigning `module-registry.service`'s UI/UX for module discovery — this PRD only specifies that branches and in-person selling move into that system, not how it's presented.
- Backfilling/migrating historical analytics or reporting that may reference `store_type` — audit separately before dropping the column (§7).
- Rider dispatch, route optimization, or other fulfillment-mechanics work (out of scope for prior food PRD too).

## 6. Audit: current state and what changes

Full file-level audit performed against both packages. Backend note: `store_type` is stored metadata almost everywhere — it does **not** gate features in module-registry, availability, subscription, or store-engagement services today, which keeps the backend migration low-risk. The real surface area is frontend.

### 6.1 DB / schema
| Item | Location | Change |
|---|---|---|
| `store_type` column + CHECK constraint | [20260720_add_food_store_branches.sql:5-8](../supabase/migrations/20260720_add_food_store_branches.sql) | New migration to drop constraint, then column, once no callers depend on it |
| `store_type` enum on settings schema | [store.ts:1045](../src/types/store.ts), [store.ts:1092](../src/types/store.ts), default at [store.ts:1265](../src/types/store.ts) | Remove |
| `store_type` on create-store request schema | [store.schemas.ts:924](../src/types/store.schemas.ts) | Remove |
| Product capability flags | *(new)* | Add `requires_shipping`, `digital_delivery`, `has_prep_time`, `age_restricted`, `license_required`, `expiry_tracked` to product schema — additive, defaults sane for existing rows |

### 6.2 Backend logic
| Item | Location | Change |
|---|---|---|
| `createStore()` accepts/persists `store_type` | [store.service.ts:679,712](../src/services/store.service.ts) | Remove param |
| Controller passthrough | [store.controller.ts:213,224](../src/controllers/store.controller.ts) | Remove |
| AI provisioning hardcodes `store_type: "food"` | [store-provisioning.service.ts:73](../src/services/ai/store-provisioning.service.ts), [store-creation.tool.ts:158](../src/services/ai/tools/store-creation.tool.ts), [ai-agent.types.ts:86](../src/types/ai-agent.types.ts) | Remove; imported items get capability flags directly instead |
| `list_stores` AI tool surfaces `store_type` | [qa.tools.ts:43](../src/services/ai/tools/qa.tools.ts) | Drop field from tool output |
| Import scripts hardcode `store_type: "food"` | `import-warmtable-json.ts:147`, `import-spiceroute-json.ts:217`, `import-sisioge-json.ts:233` | Update to set product-level `has_prep_time` instead |

### 6.3 Frontend
| Item | Location | Change |
|---|---|---|
| Store-type picker step | [StoreTypeStep.tsx](../../surge-fe/src/components/Dashboard/CreateStore/StoreTypeStep.tsx) | Delete entirely |
| `StoreType` alias | [CreateStore/types.ts:10](../../surge-fe/src/components/Dashboard/CreateStore/types.ts) | Delete |
| Dynamic step list gated on type | [CreateStoreModal.tsx:47-55,194,255-256,278,381-383,481-509](../../surge-fe/src/components/Dashboard/CreateStoreModal.tsx) | Flatten `stepsFor()`; branches becomes a module toggle, not a conditional step |
| `createStore()` threads `storeType` | [useEntityStore.ts:50-55,216-225,234](../../surge-fe/src/stores/useEntityStore.ts) | Drop param |
| `hasPhysicalLocation()` | [store.ts:634-638,836-838](../../surge-fe/src/types/store.ts) | Simplify to `sells_in_person` only |
| Inverted gate — only shows for `general` | [SellsInPersonSettings.tsx:34](../../surge-fe/src/components/Dashboard/Store/SellsInPersonSettings.tsx) | Show for all stores — it's the universal toggle now |
| `isFoodStore`/`hasPhysicalLocation` gating dashboard sections | [StoreOverview.tsx:114-135](../../surge-fe/src/components/Dashboard/Store/StoreOverview.tsx) | Re-derive from `sells_in_person` and product capability presence, not `store_type` |
| Product wizard branches on `store_type === "food"` | [LandingStep.tsx:21](../../surge-fe/src/components/Dashboard/Store/ProductWizard/LandingStep.tsx), [CategoryTimingStep.tsx:168,222](../../surge-fe/src/components/Dashboard/Store/ProductWizard/CategoryTimingStep.tsx), [ReviewStep.tsx:85](../../surge-fe/src/components/Dashboard/Store/ProductWizard/ReviewStep.tsx), [ModifiersBranchesStep.tsx:84,176](../../surge-fe/src/components/Dashboard/Store/ProductWizard/ModifiersBranchesStep.tsx), [ProductCreationWizard.tsx:126,188,210,224](../../surge-fe/src/components/Dashboard/Store/ProductWizard/ProductCreationWizard.tsx) | Re-home onto per-product capability flags (§3.2) — this is where the food-specific requirements from the superseded PRD (modifiers, prep time) actually land, just keyed by product, not store |

## 7. Open questions for review

- **Existing food stores**: do currently-`food`-typed stores get `sells_in_person` + relevant product capability flags backfilled automatically, or does an admin/merchant action re-derive them? Needs a data migration plan before the column drops.
- **Cuisine/menu concepts**: the superseded PRD's "Menu" object (a grouping above categories) and cuisine tagging — still wanted, but as product/category-level concepts rather than store-type-gated ones. Needs its own scoping pass, not resolved here.
- **Module-registry UX**: this PRD assumes branches and in-person selling move into module-registry's opt-in pattern, but doesn't specify the settings UI for it. Needs design.
- **Analytics/reporting dependence on `store_type`**: not audited in this pass — check before dropping the DB column.

## 8. Suggested phasing

1. **Schema**: add product capability flags (additive, non-breaking). Add `store_type` deprecation notice but don't drop yet.
2. **Backend**: stop writing `store_type` on create; stop branching AI provisioning/import scripts on it.
3. **Frontend**: remove `StoreTypeStep`, flatten `CreateStoreModal`, fix `hasPhysicalLocation()` and `SellsInPersonSettings` gate.
4. **Product wizard**: re-home food-specific steps onto capability flags.
5. **Cleanup**: once no code path reads `store_type`, drop the column/constraint in a dedicated migration.
6. **Later, separate PRD**: pharmacy compliance enforcement (§3.4); module-registry UX for capability opt-in (§7).

## 9. Success criteria (draft — refine with team)

- A merchant can create one store, sell a mix of digital and physical products, and never encounter a "store type" concept anywhere in onboarding.
- Enabling in-person selling or branches is a settings-page action available to every store, not a one-time signup choice.
- No code path branches on `store.store_type` (verified by removing the column without a compile/runtime error).
- Pharmacy product data can be represented in the schema (capability flags set), even though no pharmacy-specific UI ships this phase.
