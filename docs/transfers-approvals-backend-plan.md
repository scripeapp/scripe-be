# Transfers Approvals — Backend Implementation Plan

**Status**: Not started. Written up for handoff — pick this up when ready.
**Scope**: Real backend enforcement for the "Transfers" side of Settings → Approvals (`surge-fe`). Bills approvals are explicitly out of scope — Bills itself has no backend yet (still `MOCK_BILLS`), so there's nothing there to gate.

## Context

Settings → Approvals (`surge-fe/src/components/Settings/Approvals/*`) lets a merchant configure multi-tier, multi-approver sign-off workflows for Bills and Transfers. As of this writing it is entirely frontend-only: `useApprovalsStore` persists to `localStorage`, and the real, backend-connected withdrawal flow (`BankingDashboard.tsx` → `POST /banking/withdrawals` → `BankingService.requestWithdrawal`) moves money synchronously with no gate at all. This plan wires the two together for Transfers.

Three scope decisions were made with the product owner before this plan was written:

1. **Full rule fidelity.** The rule-edit modal in `WorkflowBuilderView.tsx` already lets someone pick specific approvers + "all must approve"/"any one approves" + sequence order per amount-tier rule — but today none of that structured choice is persisted, only a generated free-text description (e.g. "Any 1 of Jane Doe, John Smith"). This plan makes that real: persisted and enforced, not just a group-level approver list.
2. **Enforce `noSelfApproval`** too — currently a local-only toggle in the builder that's never saved anywhere.
3. **Ship a minimal approver-facing UI** (a "pending approvals" list with Approve/Reject) as part of this work — a backend nobody can act on isn't done.

## Two correctness fixes that are NOT optional

These were found during design review and must be implemented exactly as described, not simplified:

- **Double-spend hole.** `BankingService.getWalletBalance` (banking.service.ts:850) sums `wallet_transactions` rows with `status IN ('pending','posted')`. Today the debit row is posted *after* the Paystack call succeeds. If a gated withdrawal defers that debit until full approval (which could now take hours, not milliseconds), the balance check for a second concurrent withdrawal request during the approval window won't see the first one — two requests can each individually pass the balance check and, once both approve, double-spend. **Fix**: post the wallet debit at *gate time* — in the same step as inserting the `awaiting_approval` `banking_withdrawals` row — not at approval-completion time. On rejection, post an offsetting `reversal` credit via the existing `postWalletTransaction` helper (never rewrite the original debit row — matches the existing webhook-failure convention in `handleTransferEvent`).
- **Re-entrancy.** Two concurrent "any-one" approvers acting on the same step must not trigger two Paystack transfers. **Fix**: (a) optimistic concurrency — a `version` integer column on `transfer_approval_requests`, every decision write does a compare-and-swap `UPDATE ... WHERE id=X AND version=expected`, re-checking that the *specific step* being decided is still `pending` (not just the request as a whole); (b) a conditional claim immediately before the Paystack call in `executeApprovedWithdrawal`: `UPDATE banking_withdrawals SET status='processing' WHERE id=X AND status='awaiting_approval'` — if zero rows come back, another concurrent call already claimed it, so return without calling Paystack again. This makes the actual money-movement idempotent regardless of anything happening upstream in the approval bookkeeping.

Also worth knowing going in: `rm.analytics.manage` (already gating every `/api/banking/*` route) is **never seeded** into the `permissions` table in any existing migration — grepped all of `supabase/migrations/`, zero hits. Today only the business owner can call these routes at all, because `PermissionService.hasPermission` can never match a role to a permission key that was never inserted. Don't repeat that mistake for the new permission keys (seed both `permissions` AND `role_permissions` rows in the same migration), and don't gate the new approve/reject endpoints on `requirePermission` at all — eligibility there is a per-row, per-step check done in the service layer (RLS + `authenticateUser` already keep non-members out entirely).

## Database — 3 new migrations

Place in `surge-be/supabase/migrations/`, following the existing timestamp-prefix convention (adjust the date if it's no longer late Aug 2026 when this is picked up — check the latest existing migration file and sort after it):

**`transfer_approval_workflows` migration** — configuration tables. Give every child table its own denormalized `business_id` column (not just the parent FK chain) so RLS can use the same `is_business_member(business_id)` policy directly, matching this codebase's dominant pattern, rather than correlated-subquery policies:

- `approval_workflows` (business_id, name, type `Bills|Transfers|All`, status `active|inactive`, trigger_title, trigger_subtitle, `no_self_approval boolean default true`, created_by, timestamps). Add a **partial unique index** `WHERE status='active' AND type IN ('Transfers','All')` — an active "Transfers" workflow and an active "All" workflow must not be able to coexist, or they'd silently double-apply.
- `approval_workflow_submitters` (workflow_id, user_id?, email, name, role) — the "specific people" allowed-submitters list; empty = "anyone with payment access".
- `approval_groups` (workflow_id, title, subtitle, `position` — the step order, matching the builder's sequential flowchart).
- `approval_group_approvers` (group_id, user_id?, email, name, role).
- `approval_rules` (group_id, range_label, description, min_amount?, max_amount?, `require_all boolean`, `sequential boolean`).
- `approval_rule_approvers` (rule_id, user_id?, email, name, `position` — used when `sequential=true`).
- RLS on all six: `FOR ALL USING (is_business_member(business_id)) WITH CHECK (is_business_member(business_id))`. `set_updated_at()` triggers on workflows/groups/rules (reuse the existing trigger function).
- Also in this migration: `ALTER TABLE businesses ADD COLUMN approval_workflows_seeded_at timestamptz` — drives lazy, idempotent default-workflow seeding (see service section below); mirrors the frontend's existing "seed once, deleting it never brings it back" behavior.

**`transfer_approval_requests` migration** — the runtime table:

- `transfer_approval_requests` (business_id, withdrawal_id FK → `banking_withdrawals`, UNIQUE; workflow_id FK ON DELETE SET NULL + a `workflow_name` snapshot column so history survives workflow deletion; requested_by; amount; `status` `pending|approved|rejected|cancelled`; **`steps jsonb`** — one entry per group: `{groupId, title, position, requireAll, sequential, status, approvers:[{userId,email,name,position,decision,decidedAt}]}`; `pending_approver_ids uuid[]` GIN-indexed `WHERE status='pending'` for cheap "what's pending for me" lookups without unpacking JSONB; `version integer default 0` for optimistic concurrency; timestamps).
- The JSONB snapshot (rather than fully normalized `steps`/`decisions` child tables) is deliberate: it freezes the policy exactly as it existed when the request was created, immune to later config edits to the workflow, and mirrors the existing `banking_withdrawals.metadata jsonb` precedent already in this codebase.
- Also in this migration: widen `banking_withdrawals`'s `status` CHECK constraint to add `'awaiting_approval'` and `'rejected'`.

**`transfer_approval_permissions` migration** — seed `banking.approval_workflow.read` and `banking.approval_workflow.manage` into `permissions`, then grant both to Owner + Admin and read-only to Manager via `role_permissions`, following `20260105_add_missing_permissions.sql`'s exact two-phase INSERT pattern (confirmed real roles: Owner, Admin, Manager, Viewer, all `is_system=true`).

## Backend changes (`surge-be`)

**`src/services/banking.service.ts`** — modify `requestWithdrawal`:

1. Keep the existing PIN check, balance check, settlement-account resolution, and idempotency check unchanged.
2. Move `createTransactionReference(REFERENCE_TYPES.WITHDRAWAL)` earlier in the flow (it's a pure local generator, confirmed no external call — safe to call before any gating decision).
3. New: look up the business's one active `Transfers`/`All` workflow (join groups → rules → rule/group approvers, groups ordered by `position`). If one exists:
   - If it has submitters configured and the requester isn't one of them (matched by user_id, falling back to email) → throw a 403, no rows created at all.
   - Build a `steps` snapshot: for each group (in `position` order), match the applicable rule by the withdrawal amount (the catch-all "Everything else" rule has null bounds and always matches as a fallback), resolve required approvers (the rule's own approver subset if it has one, else the group's full approver list), then filter out the requester from that list if `no_self_approval` is set.
   - **If any resulting step ends up with zero approvers — block the withdrawal outright with a 422 naming the workflow and group.** Never create a `transfer_approval_requests` row that nobody could ever decide (money would be frozen forever). This applies uniformly whether the group was simply never configured with approvers, or `no_self_approval` filtered it down to zero.
4. Insert `banking_withdrawals`: if gated, `status: 'awaiting_approval'`, no recipient/transfer code yet; if not gated, proceed exactly as today.
5. **Post the wallet debit immediately after this insert, either way** (this closes the double-spend hole above for the gated path, and is a harmless, no-op-equivalent timing shift for the ungated path — same money, just posted slightly earlier).
6. If gated: insert `transfer_approval_requests` (`status:'pending'`, the built `steps`, `pending_approver_ids` computed from the first open step) and return the withdrawal with `status:'awaiting_approval'` — no Paystack call made. If not gated: continue exactly as today (recipient creation, transfer initiation, status mapping).

New private method `executeApprovedWithdrawal(withdrawalId)`: conditionally claims the withdrawal (`UPDATE ... WHERE status='awaiting_approval'` → 0 rows means already claimed, return early), then does the existing `createPaystackTransferRecipient` + `initiatePaystackTransfer` + status-mapping sequence unchanged (the wallet debit already exists from step 5 above — do not re-post it here).

New `listPendingApprovalsForUser(businessId, userId)`: `transfer_approval_requests` where `status='pending'` and `pending_approver_ids` contains `userId` (Postgres array containment).

New `decideApproval(requestId, businessId, actorUserId, actorEmail, decision, note?)`:
- Load the request, assert `status==='pending'`. Find the first step whose `status` is still `pending`; assert that **specific step** is still pending (not just the request-level status — closes the re-entrancy gap). Find the actor's approver entry in that step by `user_id` (fall back to email for invited-but-unregistered approvers). If `sequential`, assert the actor is the lowest-`position` approver among that step's still-pending entries, else `409` ("not your turn yet").
- Record the decision + timestamp. Re-evaluate the step: `requireAll` → satisfied once every entry is `approved`, fails the moment any entry is `rejected`; any-one → satisfied on the *first* `approved` entry, fails only once *every* listed approver has rejected with none approving.
- Re-evaluate the whole request: every step approved → `status:'approved'`; any step rejected → `status:'rejected'`.
- Write with a compare-and-swap on `version` (0 rows returned → re-read once and retry, then `409` if it still doesn't apply).
- On `approved`: `await executeApprovedWithdrawal(withdrawal_id)`. On `rejected`: set `banking_withdrawals.status='rejected'`, populate `failure_reason`, post the reversal credit described above.

**`src/services/approval-workflow.service.ts`** (new file) — CRUD matching `useApprovalsStore`'s existing action list one-to-one so the frontend rewiring is mechanical:
- `listWorkflows(businessId, creator?)` — lazily seeds the two default workflows (Bills + Transfers, sole approver = `creator`) exactly once, gated on `businesses.approval_workflows_seeded_at IS NULL`, then sets that timestamp — reproduces the frontend's existing "seed once, a deletion never comes back" behavior server-side.
- `getWorkflow`, `createWorkflow`, `updateWorkflow`, `toggleWorkflowStatus`, `duplicateWorkflow`, `deleteWorkflow` — each doing the full nested read/write across the six config tables so a response reconstructs the frontend's `ApprovalWorkflow` shape exactly.
- A private pre-check (`assertNoConflictingActiveTransfersWorkflow`) that gives a friendly error before the DB's partial unique index would otherwise reject with a raw `23505`.

**Routes**:
- New `src/routes/approval-workflows.routes.ts`, mounted at `/api/approval-workflows` in `src/app.ts` (next to where `bankingRoutes` is mounted): `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/toggle-status`, `POST /:id/duplicate`, `DELETE /:id` — each `authenticateUser` → `requirePermission("banking.approval_workflow.read"|"...manage")` → `validateRequest(...)` → controller.
- In `src/routes/banking.routes.ts`, add: `GET /approvals` (pending-for-me), `POST /approvals/:requestId/approve`, `POST /approvals/:requestId/reject` — `authenticateUser` only, per the permission-seeding note above. New Zod schema `bankingSchemas.decideApproval = { business_id: uuid, note?: string.max(500) }`.
- New controller methods on `BankingController` (`listApprovals`, `approveWithdrawal`, `rejectWithdrawal`), same try/catch + error-status convention as every other method there.

## Frontend changes (`surge-fe`)

- **`src/types/approvals.ts`**: add `approvers?: WorkflowApprover[]; requireAll?: boolean; sequential?: boolean;` to `ApprovalRule`; add `noSelfApproval?: boolean;` to `ApprovalWorkflow`. Both purely additive — no breaking change.
- **`src/components/Settings/Approvals/WorkflowBuilderView.tsx`**:
  - In `availableMembers`, set a real `id: m.user_id ?? \`invite:${m.id}\`` on each entry. Today this is typed `Omit<WorkflowApprover,"id">` — no id ever flows through from the real team roster, and the rule modal's approver toggle dedupes by **display name** (`ruleApprovers.includes(name)`), which silently breaks for two team members who happen to share a name. Carry the real `id` through `ruleApprovers`/`allowedSubmitters`/group `approvers` instead of matching by name from here on.
  - Upgrade `ruleApprovers` from `string[]` to `WorkflowApprover[]`; toggle/dedupe by `id` — mirror the `allowedSubmitters`/`toggleAllowedSubmitter` pattern already added earlier this session for the "Specific people" submitter picker. In `handleSaveRuleModal`, persist `approvers`, `requireAll: ruleRequire==="All must approve"`, `sequential: ruleOrder==="In sequence"` onto the saved `ApprovalRule`, alongside the existing generated `description` (keep that for display in the rules list).
  - Thread the `noSelfApproval` local toggle into `workflow` state and persist it in `handleSave`.
  - `handleSave`, plus `WorkflowsTable.tsx`'s `toggleWorkflowStatus`/`duplicateWorkflow`/`deleteWorkflow` calls, become `async`/awaited with `toast.error` on failure — required now that these are real network calls that can fail, not synchronous in-memory writes.
- **`src/stores/useApprovalsStore.ts`**: replace every `localStorage.getItem`/`setItem` with `apiRequestWithBusiness` calls to `/approval-workflows/*`, keeping the exact same action names (now `Promise`-returning). `getWorkflow` stays a synchronous in-memory lookup against already-loaded state, unchanged.
- **`src/components/Dashboard/Banking/BankingDashboard.tsx`**:
  - `WithdrawalResult` interface: add `approval_request_id?: string | null`.
  - `TransferReview`: add a branch for `status === "awaiting_approval"` *before* the existing `"success"` check, with real "Awaiting approval" copy — don't let it fall through to the generic "being processed" screen.
  - `WithdrawFlow.handleRequest`: currently toasts "on its way" unconditionally without even checking `status` — branch on `result.status` first.
  - New `"approvals"` tab alongside the existing Banking tabs, rendering a new `PendingApprovalsPanel.tsx` (new file, same folder) — reuse the existing `DataTable` component (`@/components/ui/DataTable`, already used by `WorkflowsTable.tsx`) for consistent styling, real loading/empty states (no placeholder rows), Approve/Reject buttons calling the two new endpoints.

## Verification plan (manual, end-to-end)

1. No active Transfers/All workflow → a withdrawal behaves exactly as it does today (immediate Paystack call, no new tables touched).
2. Configure a workflow with one group, one rule covering the test amount, 2 specific approvers, `requireAll: true`, `sequential: true`. Submit as a non-approver → `awaiting_approval`; confirm no `provider_transfer_code`/recipient exists yet, and the wallet's available balance is already reduced by the pending debit.
3. Approve out of order (2nd approver first) → `409`. Approve in the correct order → the second approval triggers `executeApprovedWithdrawal`; confirm exactly one Paystack transfer fires, and retrying the same approve call afterward now fails cleanly (request no longer pending).
4. Fresh request, reject at step 1 → `banking_withdrawals.status='rejected'`, `failure_reason` populated, a reversal credit posted, balance restored, and confirm zero Paystack calls were made at any point.
5. Configure `noSelfApproval: true` with the requester as a group's only approver → submit as that user → `422` with a clear message, not a silently-created, undecidable pending request.
6. Set `triggerAllowedSubmitters` to someone else, submit as the excluded requester → `403`, and confirm zero `banking_withdrawals`/`transfer_approval_requests` rows were created.
7. "Any-one" rule with 3 approvers → the first approval resolves the step immediately; confirm the other two now get `409` if they try to act afterward, and their entries remain `pending` in the stored snapshot (never silently rewritten).
8. Concurrency: fire two simultaneous approve calls from two different eligible any-one approvers on the same request → confirm exactly one Paystack transfer was initiated, not two.
9. Try activating a second Transfers (or "All") workflow while one is already active → a clean, friendly rejection, not a raw database constraint error leaking to the client.
10. Frontend: save a rule with specific approvers + require-all + sequential, reload the builder, confirm it round-trips correctly (not just the generated description text). Confirm the Banking → Approvals tab lists, approves, and rejects real pending requests for a business that actually has some, with no fabricated placeholder rows.

## Critical files

- `surge-be/src/services/banking.service.ts`, `surge-be/src/routes/banking.routes.ts`, `surge-be/src/controllers/banking.controller.ts`
- `surge-be/src/services/approval-workflow.service.ts` (new), `surge-be/src/routes/approval-workflows.routes.ts` (new)
- `surge-be/supabase/migrations/` — 3 new migration files (workflows/config tables, runtime request table + `banking_withdrawals` alter, permission seeds)
- `surge-fe/src/types/approvals.ts`
- `surge-fe/src/stores/useApprovalsStore.ts`
- `surge-fe/src/components/Settings/Approvals/WorkflowBuilderView.tsx`
- `surge-fe/src/components/Dashboard/Banking/BankingDashboard.tsx`, `PendingApprovalsPanel.tsx` (new)
