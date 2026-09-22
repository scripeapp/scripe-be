/**
 * Direct unit tests for the ported algorithm — no DB needed, same approach
 * as provider-events.signatures.test.ts. This logic gates real money
 * movement, so it gets real, offline, exhaustive coverage rather than only
 * being exercised indirectly through an integration test that can't run
 * without a live Postgres in this environment.
 */
import { buildStepsSnapshot, evaluateStepStatus } from "./approvals.service.js";
import type { StepApprover, Workflow, WorkflowGroup, WorkflowGroupApproverRow, WorkflowRule, WorkflowRuleApproverRow } from "./approvals.types.js";

function approverBase(overrides: Partial<{ id: string; name: string; email: string | null }> = {}) {
  return { userId: overrides.id ?? "11111111-1111-1111-1111-111111111111", email: overrides.email ?? null, name: overrides.name ?? "Approver", role: null };
}

function approver(overrides: Partial<{ id: string; name: string; email: string | null }> = {}): WorkflowGroupApproverRow {
  return { id: "approver-row", groupId: "group-1", ...approverBase(overrides) };
}

function ruleApprover(overrides: Partial<{ id: string; name: string; email: string | null }> = {}): WorkflowRuleApproverRow {
  return { id: "rule-approver-row", ruleId: "rule-1", position: 0, ...approverBase(overrides) };
}

function rule(overrides: Partial<WorkflowRule> = {}): WorkflowRule {
  return {
    id: "rule-1",
    groupId: "group-1",
    rangeLabel: "range",
    description: "",
    minAmountMinor: null,
    maxAmountMinor: null,
    requireAll: true,
    sequential: false,
    approvers: [],
    ...overrides,
  };
}

function group(overrides: Partial<WorkflowGroup> = {}): WorkflowGroup {
  return {
    id: "group-1",
    workflowId: "workflow-1",
    title: "Group 1",
    subtitle: null,
    position: 0,
    approvers: [approver({ id: "22222222-2222-2222-2222-222222222222" })],
    rules: [],
    ...overrides,
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-1",
    businessId: "business-1",
    name: "Test workflow",
    type: "withdrawal",
    status: "active",
    triggerTitle: null,
    triggerSubtitle: null,
    noSelfApproval: true,
    creatorName: "",
    creatorEmail: "",
    creatorRole: "owner",
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    submitters: [],
    groups: [group()],
    ...overrides,
  };
}

const REQUESTER = "33333333-3333-3333-3333-333333333333";
const APPROVER_A = "22222222-2222-2222-2222-222222222222";
const APPROVER_B = "44444444-4444-4444-4444-444444444444";

describe("buildStepsSnapshot", () => {
  it("uses the group's full approver list when no rule matches at all", () => {
    const steps = buildStepsSnapshot(workflow(), 1000n, REQUESTER, "requester@example.com", false);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.approvers.map((a) => a.userId)).toEqual([APPROVER_A]);
    expect(steps[0]!.requireAll).toBe(true);
    expect(steps[0]!.sequential).toBe(false);
  });

  it("picks the first non-fallback rule whose bounds contain the amount, not the narrowest one", () => {
    const wideRule = rule({ id: "wide", minAmountMinor: "0", maxAmountMinor: "1000000", requireAll: false, approvers: [ruleApprover({ id: APPROVER_A })] });
    const narrowRule = rule({ id: "narrow", minAmountMinor: "100", maxAmountMinor: "200", requireAll: true, approvers: [ruleApprover({ id: APPROVER_B })] });
    // wideRule is listed first — first-match-wins means it's chosen even
    // though narrowRule is a tighter fit for amount=150.
    const steps = buildStepsSnapshot(workflow({ groups: [group({ rules: [wideRule, narrowRule] })] }), 150n, REQUESTER, "requester@example.com", false);
    expect(steps[0]!.requireAll).toBe(false);
    expect(steps[0]!.approvers.map((a) => a.userId)).toEqual([APPROVER_A]);
  });

  it("falls back to the bounds-free catch-all rule when no bounded rule matches", () => {
    const boundedRule = rule({ id: "bounded", minAmountMinor: "0", maxAmountMinor: "100", approvers: [ruleApprover({ id: APPROVER_A })] });
    const fallbackRule = rule({ id: "fallback", minAmountMinor: null, maxAmountMinor: null, approvers: [ruleApprover({ id: APPROVER_B })] });
    const steps = buildStepsSnapshot(workflow({ groups: [group({ rules: [boundedRule, fallbackRule] })] }), 5000n, REQUESTER, "requester@example.com", false);
    expect(steps[0]!.approvers.map((a) => a.userId)).toEqual([APPROVER_B]);
  });

  it("falls back to the group's approver list when the matched rule's own approver list is empty", () => {
    const emptyRule = rule({ approvers: [] });
    const steps = buildStepsSnapshot(workflow({ groups: [group({ rules: [emptyRule] })] }), 1000n, REQUESTER, "requester@example.com", false);
    expect(steps[0]!.approvers.map((a) => a.userId)).toEqual([APPROVER_A]);
  });

  it("filters the requester out when noSelfApproval is on, matching by userId or by email", () => {
    const byId = buildStepsSnapshot(workflow({ groups: [group({ approvers: [approver({ id: REQUESTER }), approver({ id: APPROVER_B })] })] }), 1000n, REQUESTER, "requester@example.com", false);
    expect(byId[0]!.approvers.map((a) => a.userId)).toEqual([APPROVER_B]);

    const byEmail = buildStepsSnapshot(
      workflow({ groups: [group({ approvers: [approver({ id: "invite:not-a-uuid", email: "requester@example.com" }), approver({ id: APPROVER_B })] })] }),
      1000n,
      REQUESTER,
      "requester@example.com",
      false,
    );
    expect(byEmail[0]!.approvers.map((a) => a.userId)).toEqual([APPROVER_B]);
  });

  it("does not filter the requester when they are the business owner, even with noSelfApproval on", () => {
    const steps = buildStepsSnapshot(workflow({ groups: [group({ approvers: [approver({ id: REQUESTER })] })] }), 1000n, REQUESTER, "requester@example.com", true);
    expect(steps[0]!.approvers.map((a) => a.userId)).toEqual([REQUESTER]);
  });

  it("does not filter anyone when noSelfApproval is off", () => {
    const steps = buildStepsSnapshot(workflow({ noSelfApproval: false, groups: [group({ approvers: [approver({ id: REQUESTER })] })] }), 1000n, REQUESTER, "requester@example.com", false);
    expect(steps[0]!.approvers.map((a) => a.userId)).toEqual([REQUESTER]);
  });

  it("throws a 422 when a step ends up with zero eligible approvers", () => {
    expect(() => buildStepsSnapshot(workflow({ groups: [group({ title: "Finance", approvers: [approver({ id: REQUESTER })] })] }), 1000n, REQUESTER, "requester@example.com", false)).toThrow(
      /Finance.*no eligible approvers/,
    );
  });

  it("maps a non-UUID approver id (an invite placeholder) to a null userId, and re-indexes position after filtering", () => {
    const steps = buildStepsSnapshot(
      workflow({ groups: [group({ approvers: [approver({ id: REQUESTER }), approver({ id: "invite:abc123", name: "Invited" }), approver({ id: APPROVER_B })] })] }),
      1000n,
      REQUESTER,
      "requester@example.com",
      false,
    );
    expect(steps[0]!.approvers).toEqual([
      { userId: null, email: null, name: "Invited", position: 0, decision: null, decidedAt: null },
      { userId: APPROVER_B, email: null, name: "Approver", position: 1, decision: null, decidedAt: null },
    ]);
  });
});

describe("evaluateStepStatus", () => {
  function step(decisions: (StepApprover["decision"])[]): StepApprover[] {
    return decisions.map((decision, index) => ({ userId: `u${index}`, email: null, name: `u${index}`, position: index, decision, decidedAt: decision ? new Date().toISOString() : null }));
  }

  describe("requireAll semantics", () => {
    it("stays pending while some are undecided and none has rejected", () => {
      expect(evaluateStepStatus(true, step(["approved", null]))).toBe("pending");
    });
    it("resolves approved only once every approver has approved", () => {
      expect(evaluateStepStatus(true, step(["approved", "approved"]))).toBe("approved");
    });
    it("resolves rejected the moment any approver rejects, even with others still undecided", () => {
      expect(evaluateStepStatus(true, step(["approved", "rejected", null]))).toBe("rejected");
    });
  });

  describe("any-one semantics", () => {
    it("resolves approved on the first approval, even with others still undecided", () => {
      expect(evaluateStepStatus(false, step(["rejected", "approved", null]))).toBe("approved");
    });
    it("stays pending while at least one is undecided and none has approved, even if some rejected", () => {
      expect(evaluateStepStatus(false, step(["rejected", null]))).toBe("pending");
    });
    it("resolves rejected only once every approver has rejected", () => {
      expect(evaluateStepStatus(false, step(["rejected", "rejected"]))).toBe("rejected");
    });
  });
});
