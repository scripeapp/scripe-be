export type WorkflowType = "withdrawal" | "bill_payment" | "all";
export type WorkflowStatus = "active" | "inactive";
export type SubjectType = "withdrawal" | "bill_payment";
export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type Decision = "approved" | "rejected";
export type StepStatus = "pending" | "approved" | "rejected";

export interface ApproverRef {
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string;
  readonly role: string | null;
}

export interface WorkflowRuleApproverRow extends ApproverRef {
  readonly id: string;
  readonly ruleId: string;
  readonly position: number;
}

export interface WorkflowRuleRow {
  readonly id: string;
  readonly groupId: string;
  readonly rangeLabel: string;
  readonly description: string;
  readonly minAmountMinor: string | null;
  readonly maxAmountMinor: string | null;
  readonly requireAll: boolean;
  readonly sequential: boolean;
}

export interface WorkflowRule extends WorkflowRuleRow {
  readonly approvers: WorkflowRuleApproverRow[];
}

export interface WorkflowGroupApproverRow extends ApproverRef {
  readonly id: string;
  readonly groupId: string;
}

export interface WorkflowGroupRow {
  readonly id: string;
  readonly workflowId: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly position: number;
}

export interface WorkflowGroup extends WorkflowGroupRow {
  readonly approvers: WorkflowGroupApproverRow[];
  readonly rules: WorkflowRule[];
}

export interface WorkflowSubmitterRow extends ApproverRef {
  readonly id: string;
  readonly workflowId: string;
}

export interface WorkflowRow {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly type: WorkflowType;
  readonly status: WorkflowStatus;
  readonly triggerTitle: string | null;
  readonly triggerSubtitle: string | null;
  readonly noSelfApproval: boolean;
  readonly creatorName: string;
  readonly creatorEmail: string;
  readonly creatorRole: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Workflow extends WorkflowRow {
  readonly submitters: WorkflowSubmitterRow[];
  readonly groups: WorkflowGroup[];
}

export interface StepApprover {
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string;
  readonly position: number;
  readonly decision: Decision | null;
  readonly decidedAt: string | null;
}

export interface RequestStep {
  readonly groupId: string;
  readonly title: string;
  readonly position: number;
  readonly requireAll: boolean;
  readonly sequential: boolean;
  readonly status: StepStatus;
  readonly approvers: StepApprover[];
}

export interface ApprovalRequestRow {
  readonly id: string;
  readonly businessId: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly workflowId: string | null;
  readonly workflowName: string;
  readonly requestedBy: string | null;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly status: RequestStatus;
  readonly steps: RequestStep[];
  readonly pendingApproverIds: string[];
  readonly pendingPayload: Record<string, unknown> | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GateSubmissionInput {
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly requestedBy: string;
  readonly requestedByEmail: string;
  readonly requestedByIsOwner: boolean;
  readonly pendingPayload?: Record<string, unknown>;
}

export type GateResult = { readonly gated: false } | { readonly gated: true; readonly requestId: string };

export interface DecisionOutcome {
  readonly requestStatus: RequestStatus;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly requestedBy: string | null;
  readonly pendingPayload: Record<string, unknown> | null;
}

export interface ApprovalsOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface ApproverInput {
  readonly userId?: string | null;
  readonly email?: string | null;
  readonly name: string;
  readonly role?: string | null;
}

export interface RuleApproverInput extends ApproverInput {
  readonly position?: number;
}

export interface RuleInput {
  readonly rangeLabel: string;
  readonly description?: string;
  readonly minAmountMinor?: number | null;
  readonly maxAmountMinor?: number | null;
  readonly requireAll?: boolean;
  readonly sequential?: boolean;
  readonly approvers?: RuleApproverInput[];
}

export interface GroupInput {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly approvers?: ApproverInput[];
  readonly rules?: RuleInput[];
}

export interface WorkflowInput {
  readonly name: string;
  readonly type: WorkflowType;
  readonly triggerTitle?: string | null;
  readonly triggerSubtitle?: string | null;
  readonly noSelfApproval?: boolean;
  readonly submitters?: ApproverInput[];
  readonly groups?: GroupInput[];
}

export type UpdateWorkflowInput = Partial<WorkflowInput>;
