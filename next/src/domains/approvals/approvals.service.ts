import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, forbiddenError, notFoundError, validationError } from "../../shared/errors.js";
import * as authorizationRepository from "../authorization/authorization.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./approvals.repository.js";
import type {
  ApprovalsOperation,
  ApproverRef,
  Decision,
  DecisionOutcome,
  GateResult,
  GateSubmissionInput,
  RequestStatus,
  RequestStep,
  StepApprover,
  UpdateWorkflowInput,
  Workflow,
  WorkflowGroup,
  WorkflowInput,
  WorkflowRule,
  WorkflowType,
} from "./approvals.types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CAS_ATTEMPTS = 2;

/**
 * Ported from legacy's approval-workflow.service.ts buildStepsSnapshot,
 * decideApproval, findActiveWorkflow, and the inline submitter-eligibility
 * check in gateSubmission — algorithm verified line-by-line against the
 * legacy source, not reimplemented from the design doc's prose. Two
 * deliberate departures: amounts are bigint minor units instead of legacy's
 * NUMERIC major-unit amounts, and the workflow taxonomy is
 * "withdrawal" | "bill_payment" | "all" instead of legacy's
 * Bills/Transfers/transferSource (see migration 0031's header comment for
 * why — this rewrite doesn't have what that taxonomy was built for).
 */
export class ApprovalsService {
  constructor(private readonly database: Database) {}

  async listWorkflows(operation: ApprovalsOperation): Promise<Workflow[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.read");
      return repository.listWorkflows(context, operation.businessId);
    });
  }

  async getWorkflow(operation: ApprovalsOperation, workflowId: string): Promise<Workflow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.read");
      const workflow = await repository.findWorkflow(context, operation.businessId, workflowId);
      if (!workflow) throw notFoundError("Workflow not found");
      return workflow;
    });
  }

  async createWorkflow(operation: ApprovalsOperation, input: WorkflowInput): Promise<Workflow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.manage");
      if (await repository.hasConflictingActiveWorkflow(context, operation.businessId, input.type)) {
        throw conflictError(`An active workflow already covers ${input.type === "all" ? "everything" : input.type.replace("_", " ")} — deactivate it first`);
      }
      const creator = await resolveCreatorSnapshot(context, operation);
      const workflowId = await repository.createWorkflow(context, operation.businessId, operation.userId, creator, input);
      return (await repository.findWorkflow(context, operation.businessId, workflowId))!;
    });
  }

  async updateWorkflow(operation: ApprovalsOperation, workflowId: string, input: UpdateWorkflowInput): Promise<Workflow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.manage");
      if (input.type !== undefined && (await repository.hasConflictingActiveWorkflow(context, operation.businessId, input.type, workflowId))) {
        throw conflictError(`An active workflow already covers ${input.type === "all" ? "everything" : input.type.replace("_", " ")} — deactivate it first`);
      }
      const updated = await repository.updateWorkflow(context, operation.businessId, workflowId, input);
      if (!updated) throw notFoundError("Workflow not found");
      return (await repository.findWorkflow(context, operation.businessId, workflowId))!;
    });
  }

  async setWorkflowStatus(operation: ApprovalsOperation, workflowId: string, status: "active" | "inactive"): Promise<Workflow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.manage");
      if (status === "active") {
        const workflow = await repository.findWorkflow(context, operation.businessId, workflowId);
        if (!workflow) throw notFoundError("Workflow not found");
        if (await repository.hasConflictingActiveWorkflow(context, operation.businessId, workflow.type, workflowId)) {
          throw conflictError(`An active workflow already covers ${workflow.type === "all" ? "everything" : workflow.type.replace("_", " ")} — deactivate it first`);
        }
      }
      const updated = await repository.setWorkflowStatus(context, operation.businessId, workflowId, status);
      if (!updated) throw notFoundError("Workflow not found");
      return (await repository.findWorkflow(context, operation.businessId, workflowId))!;
    });
  }

  async duplicateWorkflow(operation: ApprovalsOperation, workflowId: string): Promise<Workflow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.manage");
      const creator = await resolveCreatorSnapshot(context, operation);
      const source = await repository.findWorkflow(context, operation.businessId, workflowId);
      if (!source) throw notFoundError("Workflow not found");
      const newId = await repository.createWorkflow(context, operation.businessId, operation.userId, creator, {
        name: `${source.name} (copy)`,
        type: source.type,
        triggerTitle: source.triggerTitle,
        triggerSubtitle: source.triggerSubtitle,
        noSelfApproval: source.noSelfApproval,
        submitters: source.submitters.map(toApproverInput),
        groups: source.groups.map((group) => ({
          title: group.title,
          subtitle: group.subtitle,
          approvers: group.approvers.map(toApproverInput),
          rules: group.rules.map((rule) => ({
            rangeLabel: rule.rangeLabel,
            description: rule.description,
            minAmountMinor: rule.minAmountMinor ? Number(rule.minAmountMinor) : null,
            maxAmountMinor: rule.maxAmountMinor ? Number(rule.maxAmountMinor) : null,
            requireAll: rule.requireAll,
            sequential: rule.sequential,
            approvers: rule.approvers.map((approver) => ({ ...toApproverInput(approver), position: approver.position })),
          })),
        })),
      });
      // Duplicates always land inactive — activating it would immediately
      // conflict with the workflow it was copied from (which is presumably
      // still active).
      await repository.setWorkflowStatus(context, operation.businessId, newId, "inactive");
      return (await repository.findWorkflow(context, operation.businessId, newId))!;
    });
  }

  async deleteWorkflow(operation: ApprovalsOperation, workflowId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "approvals.workflow.manage");
      const deleted = await repository.deleteWorkflow(context, operation.businessId, workflowId);
      if (!deleted) throw notFoundError("Workflow not found");
    });
  }

  /**
   * Gates a submission against the one active workflow covering `type`, if
   * any. Returns { gated: false } immediately (no rows written) when no
   * workflow applies — the caller proceeds exactly as if approvals didn't
   * exist. Throws (403 ineligible submitter, 422 a step has zero eligible
   * approvers) before writing anything when a workflow does apply but
   * blocks this specific submission.
   */
  async gateSubmission(context: DatabaseContext, businessId: string, type: Exclude<WorkflowType, "all">, input: GateSubmissionInput): Promise<GateResult> {
    const workflow = await repository.findActiveWorkflow(context, businessId, type);
    if (!workflow) return { gated: false };

    if (workflow.submitters.length > 0) {
      const allowed = workflow.submitters.some((submitter) => submitter.userId === input.requestedBy || (input.requestedByEmail && submitter.email === input.requestedByEmail));
      if (!allowed) throw forbiddenError("You are not allowed to submit into this approval workflow");
    }

    const steps = buildStepsSnapshot(workflow, BigInt(input.amountMinor), input.requestedBy, input.requestedByEmail, input.requestedByIsOwner);
    const firstStepApproverIds = steps[0]?.approvers.map((approver) => approver.userId).filter((id): id is string => id !== null) ?? [];

    const requestId = await repository.createApprovalRequest(context, businessId, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      requestedBy: input.requestedBy,
      amountMinor: input.amountMinor,
      assetCode: input.assetCode,
      steps,
      pendingApproverIds: firstStepApproverIds,
      pendingPayload: input.pendingPayload,
    });

    return { gated: true, requestId };
  }

  /**
   * Records one actor's decision on the current open step, re-evaluates
   * step and request completion, and writes with an optimistic-concurrency
   * compare-and-swap — exactly 2 attempts (matching legacy), each a full
   * re-read-and-recompute against the freshest row, not a blind retry of
   * the same write. Finalizing the underlying subject (executing a
   * withdrawal transfer, recording a bill payment allocation) is the
   * caller's job — this returns what happened, it doesn't act on it,
   * avoiding a circular dependency on banking/payables service code.
   */
  async decideApproval(operation: ApprovalsOperation, requestId: string, decision: Decision): Promise<DecisionOutcome> {
    return this.run(operation, async (context) => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const request = await repository.findApprovalRequest(context, operation.businessId, requestId);
        if (!request) throw notFoundError("Approval request not found");
        if (request.status !== "pending") throw conflictError("This request has already been decided");

        const stepIndex = request.steps.findIndex((step) => step.status === "pending");
        if (stepIndex === -1) throw conflictError("This request has no pending step");
        const step = request.steps[stepIndex]!;

        const approverIndex = step.approvers.findIndex((approver) => approver.userId === operation.userId);
        if (approverIndex === -1) throw forbiddenError("You are not an approver on this step");
        const approver = step.approvers[approverIndex]!;
        if (approver.decision !== null) throw conflictError("You have already decided on this step");

        if (step.sequential) {
          const stillPending = step.approvers.filter((entry) => entry.decision === null).sort((a, b) => a.position - b.position);
          if (stillPending[0]?.userId !== operation.userId) throw conflictError("It's not your turn to approve yet");
        }

        const updatedApprovers: StepApprover[] = step.approvers.map((entry, index) => (index === approverIndex ? { ...entry, decision, decidedAt: new Date().toISOString() } : entry));

        const stepStatus = evaluateStepStatus(step.requireAll, updatedApprovers);
        const updatedStep: RequestStep = { ...step, approvers: updatedApprovers, status: stepStatus };
        const updatedSteps = request.steps.map((entry, index) => (index === stepIndex ? updatedStep : entry));

        let requestStatus: RequestStatus = request.status;
        let nextPendingApproverIds: string[] = [];
        if (stepStatus === "rejected") {
          requestStatus = "rejected";
        } else if (stepStatus === "approved") {
          const nextStep = updatedSteps[stepIndex + 1];
          if (nextStep) {
            nextPendingApproverIds = nextStep.approvers.map((entry) => entry.userId).filter((id): id is string => id !== null);
          } else {
            requestStatus = "approved";
          }
        } else {
          nextPendingApproverIds = updatedApprovers.filter((entry) => entry.decision === null).map((entry) => entry.userId).filter((id): id is string => id !== null);
        }

        const updated = await repository.casUpdateApprovalRequest(context, requestId, request.version, { steps: updatedSteps, status: requestStatus, pendingApproverIds: nextPendingApproverIds });
        if (!updated) continue; // lost the CAS race — re-read and retry from scratch

        return { requestStatus, subjectType: request.subjectType, subjectId: request.subjectId, requestedBy: request.requestedBy, pendingPayload: request.pendingPayload };
      }

      throw conflictError("Could not record your decision — please try again");
    });
  }

  async listPendingForUser(operation: ApprovalsOperation) {
    return this.run(operation, (context) => repository.listPendingForUser(context, operation.businessId, operation.userId));
  }

  private async run<T>(operation: ApprovalsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

async function resolveCreatorSnapshot(context: DatabaseContext, operation: ApprovalsOperation): Promise<{ name: string; email: string; role: string }> {
  const [name, membership] = await Promise.all([
    authorizationRepository.findUserName(context, operation.userId),
    authorizationRepository.findMembershipByUserId(context, operation.businessId, operation.userId),
  ]);
  return { name: name ?? "", email: membership?.email ?? "", role: membership?.roles[0]?.code ?? "member" };
}

function toApproverInput(approver: ApproverRef): { userId: string | null; email: string | null; name: string; role: string | null } {
  return { userId: approver.userId, email: approver.email, name: approver.name, role: approver.role };
}

function isFallbackRule(rule: WorkflowRule): boolean {
  return rule.minAmountMinor === null && rule.maxAmountMinor === null;
}

function ruleMatchesAmount(rule: WorkflowRule, amountMinor: bigint): boolean {
  if (rule.minAmountMinor !== null && amountMinor < BigInt(rule.minAmountMinor)) return false;
  if (rule.maxAmountMinor !== null && amountMinor > BigInt(rule.maxAmountMinor)) return false;
  return true;
}

/**
 * Exact port of legacy's buildStepsSnapshot. Rule selection is first-match
 * wins in stored array order among non-fallback rules, falling back to the
 * bounds-free "everything else" rule only if no bounded rule matches — not
 * narrowest-range-wins, matching legacy's actual `.find()` semantics (see
 * the design doc's misleading "narrowest range" framing vs. what's coded).
 */
export function buildStepsSnapshot(workflow: Workflow, amountMinor: bigint, requesterId: string, requesterEmail: string, requesterIsOwner: boolean): RequestStep[] {
  return workflow.groups.map((group: WorkflowGroup, index): RequestStep => {
    const matchedRule = group.rules.find((rule) => !isFallbackRule(rule) && ruleMatchesAmount(rule, amountMinor)) ?? group.rules.find((rule) => isFallbackRule(rule));

    const rawApprovers: ApproverRef[] = matchedRule && matchedRule.approvers.length > 0 ? matchedRule.approvers : group.approvers;

    const filteredApprovers =
      workflow.noSelfApproval && !requesterIsOwner
        ? rawApprovers.filter((approver) => approver.userId !== requesterId && !(requesterEmail && approver.email === requesterEmail))
        : rawApprovers;

    if (filteredApprovers.length === 0) {
      throw validationError(`"${group.title}" has no eligible approvers for this amount — add an approver (or turn off no-self-approval) before submitting`);
    }

    return {
      groupId: group.id,
      title: group.title,
      position: index,
      requireAll: matchedRule?.requireAll ?? true,
      sequential: matchedRule?.sequential ?? false,
      status: "pending",
      approvers: filteredApprovers.map((approver, position) => ({
        userId: approver.userId && UUID_RE.test(approver.userId) ? approver.userId : null,
        email: approver.email,
        name: approver.name,
        position,
        decision: null,
        decidedAt: null,
      })),
    };
  });
}

export function evaluateStepStatus(requireAll: boolean, approvers: StepApprover[]): "pending" | "approved" | "rejected" {
  if (requireAll) {
    if (approvers.some((approver) => approver.decision === "rejected")) return "rejected";
    if (approvers.every((approver) => approver.decision === "approved")) return "approved";
    return "pending";
  }
  if (approvers.some((approver) => approver.decision === "approved")) return "approved";
  if (approvers.every((approver) => approver.decision === "rejected")) return "rejected";
  return "pending";
}
