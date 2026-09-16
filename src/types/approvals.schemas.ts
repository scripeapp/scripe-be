import { z } from "zod";

const uuid = z.string().uuid();

// A stored id is either a real auth user id (uuid) or, for an approver who
// isn't a registered teammate yet, an opaque client-side string. Matches
// the frontend's existing `id: m.user_id ?? \`invite:${m.id}\`` convention.
const approverIdSchema = z.string().trim().min(1).max(200);

const workflowApproverSchema = z.object({
  id: approverIdSchema,
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255).optional(),
  role: z.string().trim().max(120).default(""),
  initials: z.string().trim().max(10).optional(),
  avatarColor: z.string().trim().max(60).optional(),
  condition: z.string().trim().max(120).optional(),
});

const approvalRuleSchema = z.object({
  id: z.string().trim().min(1).max(200),
  rangeLabel: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  minAmount: z.number().nonnegative().nullable().optional(),
  maxAmount: z.number().nonnegative().nullable().optional(),
  approvers: z.array(workflowApproverSchema).optional(),
  requireAll: z.boolean().default(true),
  sequential: z.boolean().default(false),
});

const workflowGroupSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(300).optional(),
  approvers: z.array(workflowApproverSchema).default([]),
  rules: z.array(approvalRuleSchema).optional(),
});

// Raw (un-defaulted) field schemas, shared by both create and update.
// IMPORTANT: `.optional()` on a schema that already has `.default()` does
// NOT clear the default — Zod still substitutes it when the field is
// omitted (confirmed: `z.enum([...]).default("active").optional()` still
// parses `undefined` as `"active"`). A defaulted field silently reappearing
// on a partial PATCH would both trip the active-workflow conflict guard
// incorrectly and clobber creator_role/no_self_approval back to their
// defaults on every unrelated update. So: defaults are applied ONLY in the
// create schema below, never shared with the update schema.
const rawName = z.string().trim().min(1).max(200);
const rawCreatorEmail = z.string().trim().email().max(255);
const rawCreatorName = z.string().trim().min(1).max(255);
const rawCreatorRole = z.string().trim().max(120);
const rawType = z.enum(["Bills", "Transfers", "All"]);
const rawStatus = z.enum(["active", "inactive"]);
// Only meaningful when type is "Transfers" — which kind of transfer this
// workflow gates ("Bills" = a payment created via a bill's "Confirm
// payment"; "Manual" = a direct wallet send). Ignored by the service for
// any other type. Nullable so a client can explicitly clear it.
const rawTransferSource = z.enum(["Bills", "Manual"]).nullable();
const rawTriggerTitle = z.string().trim().max(200).nullable();
const rawTriggerSubtitle = z.string().trim().max(300).nullable();
const rawTriggerAllowedSubmitters = z.array(workflowApproverSchema);
const rawNoSelfApproval = z.boolean();
const rawGroups = z.array(workflowGroupSchema).min(1, "A workflow needs at least one approval group");

export const approvalSchemas = {
  businessIdQuery: z.object({ business_id: uuid }),
  workflowIdParam: z.object({ id: uuid }),

  listWorkflows: z.object({
    business_id: uuid,
    creator_name: z.string().trim().max(255).optional(),
    creator_email: z.string().trim().email().max(255).optional(),
  }),

  createWorkflow: z.object({
    business_id: uuid,
    name: rawName,
    creatorEmail: rawCreatorEmail,
    creatorName: rawCreatorName,
    creatorRole: rawCreatorRole.default("Owner"),
    type: rawType,
    status: rawStatus.default("active"),
    transferSource: rawTransferSource.optional(),
    triggerTitle: rawTriggerTitle.optional(),
    triggerSubtitle: rawTriggerSubtitle.optional(),
    triggerAllowedSubmitters: rawTriggerAllowedSubmitters.optional(),
    noSelfApproval: rawNoSelfApproval.default(true),
    groups: rawGroups,
  }),

  // Every field but business_id is truly optional here — omitted means
  // "leave unchanged" (see ApprovalWorkflowService.updateWorkflow), not
  // "reset to default". groups/triggerAllowedSubmitters are a full replace
  // when present, never a merge — the builder always saves its complete
  // in-memory tree.
  updateWorkflow: z.object({
    business_id: uuid,
    name: rawName.optional(),
    creatorEmail: rawCreatorEmail.optional(),
    creatorName: rawCreatorName.optional(),
    creatorRole: rawCreatorRole.optional(),
    type: rawType.optional(),
    status: rawStatus.optional(),
    transferSource: rawTransferSource.optional(),
    triggerTitle: rawTriggerTitle.optional(),
    triggerSubtitle: rawTriggerSubtitle.optional(),
    triggerAllowedSubmitters: rawTriggerAllowedSubmitters.optional(),
    noSelfApproval: rawNoSelfApproval.optional(),
    groups: rawGroups.optional(),
  }),

  businessIdBody: z.object({ business_id: uuid }),

  // ==========================================================================
  // Approval requests (runtime decisions) — distinct from workflow config
  // above. See ApprovalWorkflowService.decideApproval /
  // listPendingApprovalsForUser.
  // ==========================================================================

  requestIdParam: z.object({ requestId: uuid }),

  decideApprovalRequest: z.object({
    business_id: uuid,
    reason: z.string().trim().max(1000).nullable().optional(),
  }),
};
