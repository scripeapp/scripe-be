import { SupabaseClient } from "@supabase/supabase-js";
import { storeEmailService } from "../utils/storeEmails.util";

/**
 * Backend for Settings > Approvals (surge-fe/src/stores/useApprovalsStore.ts),
 * previously frontend-only (localStorage). Method names and shapes match
 * that store's action list one-to-one so the frontend rewiring is
 * mechanical. See docs/transfers-approvals-backend-plan.md.
 *
 * A workflow's config (this file) is separate from a specific bill or
 * transfer's in-flight approval_requests row — this service only manages
 * the reusable rule configuration, not runtime decisions.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkflowApproverInput {
  id: string;
  name: string;
  email?: string;
  role?: string;
}

export interface ApprovalRuleInput {
  id: string;
  rangeLabel: string;
  description?: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  approvers?: WorkflowApproverInput[];
  requireAll?: boolean;
  sequential?: boolean;
}

export interface WorkflowGroupInput {
  id: string;
  title: string;
  subtitle?: string;
  approvers: WorkflowApproverInput[];
  rules?: ApprovalRuleInput[];
}

export type WorkflowType = "Bills" | "Transfers" | "All";
export type WorkflowStatus = "active" | "inactive";
// Only meaningful on a 'Transfers'-type workflow: which kind of transfer it
// gates. 'Bills' = a payment created via a bill's "Confirm payment"
// (subject_type 'bill_transfer'); 'Manual' = a direct wallet send not tied
// to any bill (subject_type 'withdrawal', not gated by anything yet). A
// 'Bills'-type workflow doesn't have a source at all — bills only have one
// origin — and an 'All'-type workflow implicitly covers every source.
export type TransferSource = "Bills" | "Manual";

// A gated bill/transfer's runtime approval_requests row. 'bill_transfer'
// covers the future "Confirm payment" disbursement step; 'withdrawal' the
// existing wallet-withdrawal flow described in
// docs/transfers-approvals-backend-plan.md — neither is wired yet, but the
// subject_type enum (and this service's gating engine) is shared so all
// three go through one implementation.
export type ApprovalSubjectType = "bill" | "withdrawal" | "bill_transfer";

interface ApprovalStepApprover {
  userId: string | null;
  email?: string;
  name: string;
  position: number;
  decision: "approved" | "rejected" | null;
  decidedAt: string | null;
}

interface ApprovalStep {
  groupId: string;
  title: string;
  position: number;
  requireAll: boolean;
  sequential: boolean;
  status: "pending" | "approved" | "rejected";
  approvers: ApprovalStepApprover[];
}

export interface WorkflowInput {
  name: string;
  creatorEmail: string;
  creatorName: string;
  creatorRole?: string;
  type: WorkflowType;
  status?: WorkflowStatus;
  // Only meaningful when type is 'Transfers'; ignored for 'Bills'/'All'.
  // Optional — the service defaults a new Transfers workflow's source to
  // 'Bills' when omitted, matching how a fresh account's default workflow
  // seeds.
  transferSource?: TransferSource | null;
  triggerTitle?: string | null;
  triggerSubtitle?: string | null;
  triggerAllowedSubmitters?: WorkflowApproverInput[];
  noSelfApproval?: boolean;
  groups: WorkflowGroupInput[];
}

const WORKFLOW_SELECT = `
  id, business_id, name, type, status, transfer_source, trigger_title, trigger_subtitle,
  no_self_approval, creator_name, creator_email, creator_role,
  created_at, updated_at,
  approval_workflow_submitters ( id, user_id, email, name, role ),
  approval_groups (
    id, title, subtitle, position,
    approval_group_approvers ( id, user_id, email, name, role ),
    approval_rules (
      id, range_label, description, min_amount, max_amount, require_all, sequential,
      approval_rule_approvers ( id, user_id, email, name, role, position )
    )
  )
`;

export class ApprovalWorkflowService {
  constructor(private readonly supabase: SupabaseClient) {}

  async listWorkflows(
    businessId: string,
    creator?: { id: string; name?: string; email?: string },
  ) {
    await this.seedDefaultWorkflowsIfNeeded(businessId, creator);

    const { data, error } = await this.supabase
      .from("approval_workflows")
      .select(WORKFLOW_SELECT)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: any) => this.toApprovalWorkflow(row));
  }

  async getWorkflow(businessId: string, id: string) {
    const { data, error } = await this.supabase
      .from("approval_workflows")
      .select(WORKFLOW_SELECT)
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Approval workflow not found"), { statusCode: 404 });
    return this.toApprovalWorkflow(data);
  }

  async createWorkflow(businessId: string, userId: string | null, payload: WorkflowInput) {
    const status = payload.status ?? "active";
    // A Transfers workflow always needs a source ('Bills' or 'Manual') per
    // the DB check constraint — default to 'Bills', matching how a fresh
    // account's own default Transfers workflow seeds.
    const transferSource = payload.type === "Transfers" ? payload.transferSource ?? "Bills" : null;
    if (status === "active") {
      await this.assertNoConflictingActiveWorkflow(businessId, payload.type, transferSource, null);
    }

    const { data: workflow, error } = await this.supabase
      .from("approval_workflows")
      .insert({
        business_id: businessId,
        name: payload.name,
        type: payload.type,
        status,
        transfer_source: transferSource,
        trigger_title: payload.triggerTitle ?? null,
        trigger_subtitle: payload.triggerSubtitle ?? null,
        no_self_approval: payload.noSelfApproval ?? true,
        creator_name: payload.creatorName,
        creator_email: payload.creatorEmail,
        creator_role: payload.creatorRole ?? "Owner",
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw error;

    await this.writeWorkflowChildren(businessId, workflow.id, payload);
    return this.getWorkflow(businessId, workflow.id);
  }

  async updateWorkflow(businessId: string, id: string, payload: Partial<WorkflowInput>) {
    const existing = await this.getRawWorkflow(businessId, id);

    const nextType = payload.type ?? existing.type;
    const nextStatus = payload.status ?? existing.status;
    const nextTransferSource =
      nextType !== "Transfers"
        ? null
        : payload.transferSource !== undefined
          ? payload.transferSource ?? "Bills"
          : (existing.transfer_source ?? "Bills");
    const becomingActiveOrChangingScope =
      nextStatus === "active" &&
      (nextType !== existing.type || nextTransferSource !== existing.transfer_source || existing.status !== "active");
    if (becomingActiveOrChangingScope) {
      await this.assertNoConflictingActiveWorkflow(businessId, nextType, nextTransferSource, id);
    }

    const updates: Record<string, unknown> = {};
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.type !== undefined) updates.type = payload.type;
    if (payload.status !== undefined) updates.status = payload.status;
    if (payload.type !== undefined || payload.transferSource !== undefined) updates.transfer_source = nextTransferSource;
    if (payload.triggerTitle !== undefined) updates.trigger_title = payload.triggerTitle;
    if (payload.triggerSubtitle !== undefined) updates.trigger_subtitle = payload.triggerSubtitle;
    if (payload.noSelfApproval !== undefined) updates.no_self_approval = payload.noSelfApproval;
    if (payload.creatorName !== undefined) updates.creator_name = payload.creatorName;
    if (payload.creatorEmail !== undefined) updates.creator_email = payload.creatorEmail;
    if (payload.creatorRole !== undefined) updates.creator_role = payload.creatorRole;

    if (Object.keys(updates).length > 0) {
      const { error } = await this.supabase
        .from("approval_workflows")
        .update(updates)
        .eq("id", id)
        .eq("business_id", businessId);
      if (error) throw error;
    }

    // The builder always saves its complete in-memory tree, never a partial
    // diff — so groups/submitters are a full replace whenever provided,
    // not a merge.
    if (payload.groups !== undefined || payload.triggerAllowedSubmitters !== undefined) {
      await this.deleteWorkflowChildren(id);
      await this.writeWorkflowChildren(businessId, id, {
        name: existing.name,
        creatorEmail: existing.creator_email,
        creatorName: existing.creator_name,
        creatorRole: existing.creator_role,
        type: nextType,
        status: nextStatus,
        groups: payload.groups ?? [],
        triggerAllowedSubmitters: payload.triggerAllowedSubmitters ?? [],
      });
    }

    return this.getWorkflow(businessId, id);
  }

  async toggleWorkflowStatus(businessId: string, id: string) {
    const existing = await this.getRawWorkflow(businessId, id);
    const nextStatus: WorkflowStatus = existing.status === "active" ? "inactive" : "active";
    if (nextStatus === "active") {
      await this.assertNoConflictingActiveWorkflow(businessId, existing.type, existing.transfer_source, id);
    }

    const { error } = await this.supabase
      .from("approval_workflows")
      .update({ status: nextStatus })
      .eq("id", id)
      .eq("business_id", businessId);
    if (error) throw error;
    return this.getWorkflow(businessId, id);
  }

  async duplicateWorkflow(businessId: string, id: string) {
    const source = await this.getWorkflow(businessId, id);

    // Duplicating an active workflow would immediately collide with the
    // active-uniqueness constraint (a business can't have two active
    // workflows covering the same type) — land the copy inactive, same as
    // any other newly-created workflow the merchant hasn't activated yet.
    const { data: workflow, error } = await this.supabase
      .from("approval_workflows")
      .insert({
        business_id: businessId,
        name: `${source.name} (Copy)`,
        type: source.type,
        status: "inactive",
        transfer_source: source.type === "Transfers" ? source.transferSource ?? null : null,
        trigger_title: source.triggerTitle ?? null,
        trigger_subtitle: source.triggerSubtitle ?? null,
        no_self_approval: source.noSelfApproval,
        creator_name: source.creatorName,
        creator_email: source.creatorEmail,
        creator_role: source.creatorRole,
      })
      .select("id")
      .single();
    if (error) throw error;

    await this.writeWorkflowChildren(businessId, workflow.id, {
      name: source.name,
      creatorEmail: source.creatorEmail,
      creatorName: source.creatorName,
      creatorRole: source.creatorRole,
      type: source.type,
      status: "inactive",
      transferSource: source.transferSource,
      triggerAllowedSubmitters: source.triggerAllowedSubmitters,
      groups: source.groups,
    });
    return this.getWorkflow(businessId, workflow.id);
  }

  async deleteWorkflow(businessId: string, id: string) {
    const { error } = await this.supabase
      .from("approval_workflows")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId);
    if (error) throw error;
  }

  // ==========================================================================
  // Approval requests (runtime decisions) — gates a bill/transfer against
  // the business's active workflow (if any) and records step-by-step
  // decisions. Subject-agnostic: the caller (a controller) is responsible
  // for finalizing the actual bill/withdrawal/transfer once a request
  // resolves — this service only tracks the approval chain itself.
  // ==========================================================================

  /**
   * Called when a bill/transfer is first submitted. If the business has no
   * active workflow covering it, returns `{ gated: false }` and the caller
   * proceeds exactly as it would with no approvals feature at all. If one
   * exists, builds and stores a full steps snapshot (frozen at submission
   * time, immune to later workflow edits) and returns the new request id.
   */
  async gateSubmission(
    businessId: string,
    params: {
      subjectType: ApprovalSubjectType;
      subjectId: string;
      amount: number;
      requestedBy: string;
      requestedByEmail?: string | null;
      // A short human-readable description of what's being submitted (e.g.
      // "Bill INV-3680 — Lekki Fresh Produce Ltd") — this service never
      // joins into bills/suppliers itself, so the caller (which already has
      // the record in hand) supplies it, purely for the approval-requested
      // email. Omitted entirely just means a slightly plainer email.
      subjectLabel?: string;
    },
  ): Promise<{ gated: boolean; requestId?: string }> {
    const coverageType = params.subjectType === "bill" ? "Bills" : "Transfers";
    // 'bill_transfer' = a payment created from a bill's "Confirm payment"
    // (source 'Bills'); 'withdrawal' = a direct wallet send (source
    // 'Manual', not gated by anything yet — no workflow will ever match
    // this source until that path is wired up).
    const source: TransferSource | undefined =
      params.subjectType === "bill_transfer" ? "Bills" : params.subjectType === "withdrawal" ? "Manual" : undefined;
    const workflow = await this.findActiveWorkflow(businessId, coverageType, source);
    if (!workflow) return { gated: false };

    if (workflow.triggerAllowedSubmitters && workflow.triggerAllowedSubmitters.length > 0) {
      const allowed = workflow.triggerAllowedSubmitters.some(
        (s: any) => s.id === params.requestedBy || (params.requestedByEmail && s.email === params.requestedByEmail),
      );
      if (!allowed) {
        throw Object.assign(new Error("You are not allowed to submit into this approval workflow"), { statusCode: 403 });
      }
    }

    const requesterIsOwner = await this.isBusinessOwner(businessId, params.requestedBy);
    const steps = this.buildStepsSnapshot(
      workflow,
      params.amount,
      params.requestedBy,
      params.requestedByEmail,
      requesterIsOwner,
    );
    const pendingApproverIds = (steps[0]?.approvers ?? [])
      .map((a) => a.userId)
      .filter((id): id is string => !!id);

    const { data, error } = await this.supabase
      .from("approval_requests")
      .insert({
        business_id: businessId,
        subject_type: params.subjectType,
        subject_id: params.subjectId,
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        requested_by: params.requestedBy,
        amount: params.amount,
        status: "pending",
        steps,
        pending_approver_ids: pendingApproverIds,
      })
      .select("id")
      .single();
    if (error) throw error;

    // Best-effort — a failed/slow email must never fail the submission
    // itself, which has already been recorded above.
    this.notifyApprovers(businessId, workflow.name, steps[0], params).catch((err) =>
      console.error("[ApprovalWorkflowService.gateSubmission] Failed to notify approvers:", err),
    );

    return { gated: true, requestId: data.id };
  }

  /** Emails every approver on a request's first pending step — otherwise
   * the only way anyone finds out something needs a decision is by
   * remembering to open Payments > Approvals. */
  private async notifyApprovers(
    businessId: string,
    workflowName: string,
    firstStep: ApprovalStep | undefined,
    params: {
      subjectType: ApprovalSubjectType;
      amount: number;
      requestedBy: string;
      requestedByEmail?: string | null;
      subjectLabel?: string;
    },
  ): Promise<void> {
    if (!firstStep || firstStep.approvers.length === 0) return;

    const { data: business } = await this.supabase
      .from("businesses")
      .select("name")
      .eq("id", businessId)
      .maybeSingle();
    const businessName = (business as any)?.name ?? "your business";

    // Approver rows carry an email when one was set at config time, but
    // fall back to the users table for any that don't (a real teammate
    // picked from the roster always has one there).
    const missingEmailIds = firstStep.approvers.filter((a) => !a.email && a.userId).map((a) => a.userId as string);
    const idsToLookUp = Array.from(new Set([...missingEmailIds, params.requestedBy]));
    const userById = new Map<string, { name?: string; email?: string }>();
    if (idsToLookUp.length > 0) {
      const { data: users } = await this.supabase.from("users").select("id, name, email").in("id", idsToLookUp);
      for (const u of (users as any[]) ?? []) userById.set(u.id, { name: u.name, email: u.email });
    }

    const requestedByLabel =
      userById.get(params.requestedBy)?.name ?? params.requestedByEmail ?? "A teammate";
    const isTransfer = params.subjectType === "bill_transfer" || params.subjectType === "withdrawal";
    const subjectLabel =
      params.subjectLabel ?? (params.subjectType === "bill" ? "A bill" : "A vendor payment");

    await Promise.all(
      firstStep.approvers.map((approver) => {
        const email = approver.email ?? (approver.userId ? userById.get(approver.userId)?.email : undefined);
        if (!email) return Promise.resolve();
        return storeEmailService.sendApprovalRequestedEmail({
          approverEmail: email,
          approverName: approver.name || "there",
          businessId,
          businessName,
          workflowName,
          subjectLabel,
          isTransfer,
          amount: params.amount,
          currency: "NGN",
          requestedByLabel,
        });
      }),
    );
  }

  /** The one pending approval_requests row for a subject, if any — used to
   * block a direct/ungated approve-or-reject action once a real multi-step
   * chain is already tracking it. */
  async getPendingApprovalRequest(businessId: string, subjectType: ApprovalSubjectType, subjectId: string) {
    const { data, error } = await this.supabase
      .from("approval_requests")
      .select("id, status")
      .eq("business_id", businessId)
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId)
      .eq("status", "pending")
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  /** The full request for a subject regardless of status — for display
   * (e.g. "matched rule: ... needs Owner and Finance", who it's waiting on),
   * not just the pending-decision guard above. */
  async getRequestForSubject(businessId: string, subjectType: ApprovalSubjectType, subjectId: string) {
    const { data, error } = await this.supabase
      .from("approval_requests")
      .select("id, subject_type, subject_id, workflow_name, requested_by, amount, status, steps, created_at")
      .eq("business_id", businessId)
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async listPendingApprovalsForUser(businessId: string, userId: string) {
    const { data, error } = await this.supabase
      .from("approval_requests")
      .select("id, subject_type, subject_id, workflow_name, requested_by, amount, status, steps, created_at")
      .eq("business_id", businessId)
      .eq("status", "pending")
      .contains("pending_approver_ids", [userId])
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  /**
   * Records one approver's decision on the current pending step of a
   * request, re-evaluates that step (require-all vs. any-one) and the
   * request as a whole, and returns the outcome for the caller to act on
   * (finalize the underlying bill/transfer on full approval/rejection).
   * Uses optimistic concurrency (compare-and-swap on `version`) so two
   * concurrent "any-one" approvers acting on the same step can't both win —
   * retries once against fresh state before giving up.
   */
  async decideApproval(
    businessId: string,
    requestId: string,
    actorUserId: string,
    decision: "approved" | "rejected",
  ): Promise<{ requestStatus: "pending" | "approved" | "rejected"; subjectType: ApprovalSubjectType; subjectId: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: request, error } = await this.supabase
        .from("approval_requests")
        .select("*")
        .eq("id", requestId)
        .eq("business_id", businessId)
        .maybeSingle();
      if (error) throw error;
      if (!request) throw Object.assign(new Error("Approval request not found"), { statusCode: 404 });
      if (request.status !== "pending") {
        throw Object.assign(new Error("This request has already been decided"), { statusCode: 409 });
      }

      const steps: ApprovalStep[] = request.steps;
      const stepIndex = steps.findIndex((s) => s.status === "pending");
      if (stepIndex === -1) {
        throw Object.assign(new Error("This request has no pending step"), { statusCode: 409 });
      }
      const step = steps[stepIndex];
      const approverIndex = step.approvers.findIndex((a) => a.userId === actorUserId);
      if (approverIndex === -1) {
        throw Object.assign(new Error("You are not an approver on this step"), { statusCode: 403 });
      }
      const approver = step.approvers[approverIndex];
      if (approver.decision) {
        throw Object.assign(new Error("You have already decided on this step"), { statusCode: 409 });
      }

      if (step.sequential) {
        const stillPending = [...step.approvers].filter((a) => !a.decision).sort((a, b) => a.position - b.position);
        if (stillPending[0]?.userId !== actorUserId) {
          throw Object.assign(new Error("It's not your turn to approve yet"), { statusCode: 409 });
        }
      }

      const updatedApprovers = step.approvers.map((a, i) =>
        i === approverIndex ? { ...a, decision, decidedAt: new Date().toISOString() } : a,
      );

      let stepStatus: "pending" | "approved" | "rejected" = "pending";
      if (step.requireAll) {
        if (updatedApprovers.some((a) => a.decision === "rejected")) stepStatus = "rejected";
        else if (updatedApprovers.every((a) => a.decision === "approved")) stepStatus = "approved";
      } else {
        if (updatedApprovers.some((a) => a.decision === "approved")) stepStatus = "approved";
        else if (updatedApprovers.every((a) => a.decision === "rejected")) stepStatus = "rejected";
      }

      const updatedStep: ApprovalStep = { ...step, approvers: updatedApprovers, status: stepStatus };
      const updatedSteps = steps.map((s, i) => (i === stepIndex ? updatedStep : s));

      let requestStatus: "pending" | "approved" | "rejected" = "pending";
      let nextPendingApproverIds: string[];

      if (stepStatus === "rejected") {
        requestStatus = "rejected";
        nextPendingApproverIds = [];
      } else if (stepStatus === "approved") {
        const nextStep = updatedSteps[stepIndex + 1];
        if (nextStep) {
          nextPendingApproverIds = nextStep.approvers.map((a) => a.userId).filter((id): id is string => !!id);
        } else {
          requestStatus = "approved";
          nextPendingApproverIds = [];
        }
      } else {
        // Still pending — an any-one step with more untried approvers.
        nextPendingApproverIds = updatedApprovers
          .filter((a) => !a.decision)
          .map((a) => a.userId)
          .filter((id): id is string => !!id);
      }

      const { data: updated, error: updateError } = await this.supabase
        .from("approval_requests")
        .update({
          steps: updatedSteps,
          status: requestStatus,
          pending_approver_ids: nextPendingApproverIds,
          version: request.version + 1,
        })
        .eq("id", requestId)
        .eq("version", request.version)
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updated) continue; // lost a race — retry once against fresh state

      return { requestStatus, subjectType: request.subject_type, subjectId: request.subject_id };
    }

    throw Object.assign(new Error("Could not record your decision — please try again"), { statusCode: 409 });
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  /** A business's first-ever visit to Approvals seeds two real starting
   * workflows (Bills + Transfers, sole approver the creator) exactly once,
   * gated on approval_workflows_seeded_at — mirrors the frontend's existing
   * "seed once, a deletion never brings it back" behavior, now server-side. */
  private async seedDefaultWorkflowsIfNeeded(
    businessId: string,
    creator?: { id: string; name?: string; email?: string },
  ) {
    const { data: business, error } = await this.supabase
      .from("businesses")
      .select("approval_workflows_seeded_at")
      .eq("id", businessId)
      .maybeSingle();
    if (error) throw error;
    if (!business || business.approval_workflows_seeded_at) return;
    // Wait for real creator info to be available, same as the frontend does
    // — never fabricate a placeholder approver.
    if (!creator?.email) return;

    const resolvedCreator = { id: creator.id, name: creator.name || creator.email, email: creator.email };
    await this.createWorkflow(businessId, creator.id, this.buildDefaultWorkflowInput("Bills", resolvedCreator));
    await this.createWorkflow(businessId, creator.id, this.buildDefaultWorkflowInput("Transfers", resolvedCreator));

    const { error: markError } = await this.supabase
      .from("businesses")
      .update({ approval_workflows_seeded_at: new Date().toISOString() })
      .eq("id", businessId);
    if (markError) throw markError;
  }

  private buildDefaultWorkflowInput(
    type: "Bills" | "Transfers",
    creator: { id: string; name: string; email: string },
  ): WorkflowInput {
    return {
      name: `Default ${type} workflow`,
      creatorEmail: creator.email,
      creatorName: creator.name,
      creatorRole: "Owner",
      type,
      // Both ship active from day one — bills need a workflow immediately,
      // and Transfers is scoped to source 'Bills' by default (a payment
      // created from a bill's "Confirm payment"), not 'Manual' (a direct
      // wallet send) — so it only ever gates money leaving via an already-
      // reviewed bill, never an ad-hoc transfer, and can't lock the owner
      // out of their own account before they've set up a team.
      status: "active",
      transferSource: type === "Transfers" ? "Bills" : undefined,
      triggerTitle: type === "Bills" ? "Bills Submitted" : "Transfers Initiated",
      triggerSubtitle: "Anyone with payment access",
      noSelfApproval: true,
      groups: [
        {
          id: "seed-group",
          title: "Approval group 1",
          subtitle: type === "Bills" ? "All bills" : "All transfers",
          approvers: [
            { id: creator.id, name: creator.name, email: creator.email, role: "Owner" },
          ],
          rules: [
            {
              id: "seed-rule",
              rangeLabel: "Everything else",
              description: "All approvers in this group must approve",
              requireAll: true,
              sequential: false,
            },
          ],
        },
      ],
    };
  }

  /** The one active workflow covering a given kind of submission (its own
   * type, or 'All') — enforced unique by the two partial indexes on
   * approval_workflows, so at most one row can ever match. */
  private async findActiveWorkflow(
    businessId: string,
    coverageType: "Bills" | "Transfers",
    source?: TransferSource,
  ) {
    const { data, error } = await this.supabase
      .from("approval_workflows")
      .select(WORKFLOW_SELECT)
      .eq("business_id", businessId)
      .eq("status", "active")
      .in("type", [coverageType, "All"]);
    if (error) throw error;

    // An 'All' workflow covers every source; a 'Transfers' one only
    // matches when its own declared source matches what's being
    // submitted. Filtered in JS rather than in the query — there are only
    // ever one or two active rows per business by construction (the
    // partial unique indexes enforce that), so this never scans anything
    // meaningful, and avoids fighting PostgREST's OR-group filter syntax
    // for what's a three-way conditional anyway.
    const match = (data ?? []).find((row: any) => {
      if (row.type === "All") return true;
      if (coverageType === "Bills") return row.type === "Bills";
      return row.type === "Transfers" && (!source || row.transfer_source === source);
    });

    return match ? this.toApprovalWorkflow(match) : null;
  }

  /** The business's own founding role — an Owner is exempt from
   * no-self-approval (they may approve their own submission), everyone
   * else is not. Resolves via memberships -> roles.is_owner rather than a
   * name check, matching how the rest of this codebase treats ownership. */
  private async isBusinessOwner(businessId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("memberships")
      .select("role:roles(is_owner)")
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    const role = (data as any)?.role;
    const roleRow = Array.isArray(role) ? role[0] : role;
    return Boolean(roleRow?.is_owner);
  }

  private isFallbackRule(rule: { minAmount?: number; maxAmount?: number }): boolean {
    return rule.minAmount == null && rule.maxAmount == null;
  }

  private ruleMatchesAmount(rule: { minAmount?: number; maxAmount?: number }, amount: number): boolean {
    if (rule.minAmount != null && amount < rule.minAmount) return false;
    if (rule.maxAmount != null && amount > rule.maxAmount) return false;
    return true;
  }

  /** For each group (in position order — sequential stages of the chain),
   * picks the narrowest amount-matching rule (falling back to the
   * bounds-free "Everything else" rule), resolves its approver list (the
   * rule's own subset, else the whole group), drops the requester when
   * no-self-approval is on (unless the requester is the business Owner —
   * an Owner may approve their own submission regardless of that setting),
   * and throws a blocking 422 if that leaves a step with nobody who could
   * ever decide it — never silently create an undecidable request. */
  private buildStepsSnapshot(
    workflow: ReturnType<ApprovalWorkflowService["toApprovalWorkflow"]>,
    amount: number,
    requesterId: string,
    requesterEmail: string | null | undefined,
    requesterIsOwner: boolean,
  ): ApprovalStep[] {
    return workflow.groups.map((group: any, index: number) => {
      const rules: any[] = group.rules ?? [];
      const matchedRule =
        rules.find((r) => !this.isFallbackRule(r) && this.ruleMatchesAmount(r, amount)) ??
        rules.find((r) => this.isFallbackRule(r));

      const rawApprovers: any[] =
        matchedRule?.approvers && matchedRule.approvers.length > 0 ? matchedRule.approvers : group.approvers;

      const filteredApprovers = workflow.noSelfApproval && !requesterIsOwner
        ? rawApprovers.filter((a) => a.id !== requesterId && !(requesterEmail && a.email === requesterEmail))
        : rawApprovers;

      if (filteredApprovers.length === 0) {
        throw Object.assign(
          new Error(
            `"${group.title}" has no eligible approvers for this amount — add an approver (or turn off no-self-approval) before submitting`,
          ),
          { statusCode: 422 },
        );
      }

      return {
        groupId: group.id,
        title: group.title,
        position: index,
        requireAll: matchedRule?.requireAll ?? true,
        sequential: matchedRule?.sequential ?? false,
        status: "pending" as const,
        approvers: filteredApprovers.map((a: any, position: number) => ({
          userId: UUID_RE.test(a.id) ? a.id : null,
          email: a.email,
          name: a.name,
          position,
          decision: null,
          decidedAt: null,
        })),
      };
    });
  }

  private async getRawWorkflow(businessId: string, id: string) {
    const { data, error } = await this.supabase
      .from("approval_workflows")
      .select("id, type, status, transfer_source, name, creator_name, creator_email, creator_role")
      .eq("id", id)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Approval workflow not found"), { statusCode: 404 });
    return data as {
      id: string;
      type: WorkflowType;
      status: WorkflowStatus;
      transfer_source: TransferSource | null;
      name: string;
      creator_name: string;
      creator_email: string;
      creator_role: string;
    };
  }

  /** An active workflow's coverage must never overlap another active
   * workflow's — 'All' covers both Bills and Transfers (every source), so it
   * conflicts with an active workflow of either specific type (and with a
   * second active 'All'). A 'Transfers' workflow only conflicts with another
   * active 'Transfers' workflow sharing the same source — a Bills-sourced
   * and a Manual-sourced one may both be active at once. Called before any
   * write that would activate a workflow, giving a friendly error ahead of
   * the DB's partial unique indexes. */
  private async assertNoConflictingActiveWorkflow(
    businessId: string,
    type: WorkflowType,
    transferSource: TransferSource | null,
    excludeId: string | null,
  ) {
    const conflictingTypes = type === "All" ? ["Bills", "Transfers", "All"] : [type, "All"];
    let query = this.supabase
      .from("approval_workflows")
      .select("id, name, type, transfer_source")
      .eq("business_id", businessId)
      .eq("status", "active")
      .in("type", conflictingTypes);
    if (excludeId) query = query.neq("id", excludeId);

    const { data, error } = await query;
    if (error) throw error;

    const conflict = (data ?? []).find((row: any) => {
      if (row.type === "All" || type === "All") return true;
      if (type !== "Transfers") return true; // Bills vs Bills
      // Both are 'Transfers' — only a conflict if they share a source.
      return row.transfer_source === transferSource;
    });

    if (conflict) {
      const coverage = conflict.type === "All" ? "Bills and Transfers" : conflict.type;
      throw Object.assign(
        new Error(`"${conflict.name}" is already active for ${coverage} — deactivate it before activating this one`),
        { statusCode: 409 },
      );
    }
  }

  private async writeWorkflowChildren(businessId: string, workflowId: string, payload: WorkflowInput) {
    if (payload.triggerAllowedSubmitters && payload.triggerAllowedSubmitters.length > 0) {
      const { error } = await this.supabase.from("approval_workflow_submitters").insert(
        payload.triggerAllowedSubmitters.map((approver) =>
          this.approverRow(businessId, { workflow_id: workflowId }, approver),
        ),
      );
      if (error) throw error;
    }

    for (let i = 0; i < payload.groups.length; i++) {
      const group = payload.groups[i];
      const { data: groupRow, error: groupError } = await this.supabase
        .from("approval_groups")
        .insert({
          business_id: businessId,
          workflow_id: workflowId,
          title: group.title,
          subtitle: group.subtitle ?? null,
          position: i,
        })
        .select("id")
        .single();
      if (groupError) throw groupError;

      if (group.approvers.length > 0) {
        const { error } = await this.supabase.from("approval_group_approvers").insert(
          group.approvers.map((approver) => this.approverRow(businessId, { group_id: groupRow.id }, approver)),
        );
        if (error) throw error;
      }

      for (const rule of group.rules ?? []) {
        const { data: ruleRow, error: ruleError } = await this.supabase
          .from("approval_rules")
          .insert({
            business_id: businessId,
            group_id: groupRow.id,
            range_label: rule.rangeLabel,
            description: rule.description ?? "",
            min_amount: rule.minAmount ?? null,
            max_amount: rule.maxAmount ?? null,
            require_all: rule.requireAll ?? true,
            sequential: rule.sequential ?? false,
          })
          .select("id")
          .single();
        if (ruleError) throw ruleError;

        if (rule.approvers && rule.approvers.length > 0) {
          const { error } = await this.supabase.from("approval_rule_approvers").insert(
            rule.approvers.map((approver, position) =>
              this.approverRow(businessId, { rule_id: ruleRow.id, position }, approver),
            ),
          );
          if (error) throw error;
        }
      }
    }
  }

  private async deleteWorkflowChildren(workflowId: string) {
    // Cascades to approval_group_approvers, approval_rules, and
    // approval_rule_approvers via ON DELETE CASCADE.
    const { error: groupsError } = await this.supabase.from("approval_groups").delete().eq("workflow_id", workflowId);
    if (groupsError) throw groupsError;
    const { error: submittersError } = await this.supabase
      .from("approval_workflow_submitters")
      .delete()
      .eq("workflow_id", workflowId);
    if (submittersError) throw submittersError;
  }

  private approverRow(businessId: string, extra: Record<string, unknown>, approver: WorkflowApproverInput) {
    return {
      business_id: businessId,
      user_id: UUID_RE.test(approver.id) ? approver.id : null,
      email: approver.email ?? null,
      name: approver.name,
      role: approver.role ?? null,
      ...extra,
    };
  }

  private toWorkflowApprover(row: any) {
    return {
      id: row.user_id ?? `invite:${row.id}`,
      name: row.name,
      email: row.email ?? undefined,
      role: row.role ?? "",
    };
  }

  private toApprovalWorkflow(row: any) {
    const groups = [...(row.approval_groups ?? [])]
      .sort((a: any, b: any) => a.position - b.position)
      .map((group: any) => ({
        id: group.id,
        title: group.title,
        subtitle: group.subtitle ?? "",
        approvers: (group.approval_group_approvers ?? []).map((a: any) => this.toWorkflowApprover(a)),
        rules: (group.approval_rules ?? []).map((rule: any) => ({
          id: rule.id,
          rangeLabel: rule.range_label,
          description: rule.description ?? "",
          minAmount: rule.min_amount != null ? Number(rule.min_amount) : undefined,
          maxAmount: rule.max_amount != null ? Number(rule.max_amount) : undefined,
          requireAll: rule.require_all,
          sequential: rule.sequential,
          approvers: [...(rule.approval_rule_approvers ?? [])]
            .sort((a: any, b: any) => a.position - b.position)
            .map((a: any) => this.toWorkflowApprover(a)),
        })),
      }));

    return {
      id: row.id,
      name: row.name,
      creatorEmail: row.creator_email,
      creatorName: row.creator_name,
      creatorRole: row.creator_role,
      type: row.type as WorkflowType,
      status: row.status as WorkflowStatus,
      transferSource: (row.transfer_source as TransferSource | null) ?? undefined,
      triggerTitle: row.trigger_title ?? undefined,
      triggerSubtitle: row.trigger_subtitle ?? undefined,
      triggerAllowedSubmitters: (row.approval_workflow_submitters ?? []).map((a: any) => this.toWorkflowApprover(a)),
      noSelfApproval: row.no_self_approval,
      groups,
      createdAt: row.created_at,
      lastActive: row.updated_at,
    };
  }
}
