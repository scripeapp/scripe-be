import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  ApprovalRequestRow,
  ApproverInput,
  GroupInput,
  RuleApproverInput,
  SubjectType,
  Workflow,
  WorkflowGroup,
  WorkflowGroupApproverRow,
  WorkflowGroupRow,
  WorkflowInput,
  WorkflowRow,
  WorkflowRule,
  WorkflowRuleApproverRow,
  WorkflowRuleRow,
  WorkflowSubmitterRow,
  WorkflowType,
} from "./approvals.types.js";

const WORKFLOW_COLUMNS = `"id", "businessId", "name", "type", "status", "triggerTitle", "triggerSubtitle", "noSelfApproval", "creatorName", "creatorEmail", "creatorRole", "createdBy", "createdAt", "updatedAt"`;
const REQUEST_COLUMNS = `"id", "businessId", "subjectType", "subjectId", "workflowId", "workflowName", "requestedBy", "amountMinor", "assetCode", "status", "steps", "pendingApproverIds", "pendingPayload", "version", "createdAt", "updatedAt"`;

async function hydrateWorkflows(context: DatabaseContext, rows: WorkflowRow[]): Promise<Workflow[]> {
  if (rows.length === 0) return [];
  const workflowIds = rows.map((row) => row.id);

  const [submitters, groups] = await Promise.all([
    sql<WorkflowSubmitterRow>`select "id","workflowId","userId","email","name","role" from app.approval_workflow_submitters where "workflowId" = any(${workflowIds})`.execute(context.transaction),
    sql<WorkflowGroupRow>`select "id","workflowId","title","subtitle","position" from app.approval_groups where "workflowId" = any(${workflowIds}) order by "position"`.execute(context.transaction),
  ]);

  const groupIds = groups.rows.map((group) => group.id);
  const [groupApprovers, rules] =
    groupIds.length === 0
      ? [{ rows: [] as WorkflowGroupApproverRow[] }, { rows: [] as WorkflowRuleRow[] }]
      : await Promise.all([
          sql<WorkflowGroupApproverRow>`select "id","groupId","userId","email","name","role" from app.approval_group_approvers where "groupId" = any(${groupIds})`.execute(context.transaction),
          sql<WorkflowRuleRow>`select "id","groupId","rangeLabel","description","minAmountMinor"::text,"maxAmountMinor"::text,"requireAll","sequential" from app.approval_rules where "groupId" = any(${groupIds})`.execute(context.transaction),
        ]);

  const ruleIds = rules.rows.map((rule) => rule.id);
  const ruleApprovers =
    ruleIds.length === 0
      ? []
      : (await sql<WorkflowRuleApproverRow>`select "id","ruleId","userId","email","name","role","position" from app.approval_rule_approvers where "ruleId" = any(${ruleIds}) order by "position"`.execute(context.transaction)).rows;

  const rulesByGroup = new Map<string, WorkflowRule[]>();
  for (const rule of rules.rows) {
    const approvers = ruleApprovers.filter((approver) => approver.ruleId === rule.id);
    const list = rulesByGroup.get(rule.groupId) ?? [];
    list.push({ ...rule, approvers });
    rulesByGroup.set(rule.groupId, list);
  }

  const groupsByWorkflow = new Map<string, WorkflowGroup[]>();
  for (const group of groups.rows) {
    const approvers = groupApprovers.rows.filter((approver) => approver.groupId === group.id);
    const list = groupsByWorkflow.get(group.workflowId) ?? [];
    list.push({ ...group, approvers, rules: rulesByGroup.get(group.id) ?? [] });
    groupsByWorkflow.set(group.workflowId, list);
  }

  return rows.map((row) => ({
    ...row,
    submitters: submitters.rows.filter((submitter) => submitter.workflowId === row.id),
    groups: groupsByWorkflow.get(row.id) ?? [],
  }));
}

export async function listWorkflows(context: DatabaseContext, businessId: string): Promise<Workflow[]> {
  const result = await sql<WorkflowRow>`select ${sql.raw(WORKFLOW_COLUMNS)} from app.approval_workflows where "businessId" = ${businessId}::uuid order by "createdAt"`.execute(context.transaction);
  return hydrateWorkflows(context, result.rows);
}

export async function findWorkflow(context: DatabaseContext, businessId: string, workflowId: string): Promise<Workflow | undefined> {
  const result = await sql<WorkflowRow>`select ${sql.raw(WORKFLOW_COLUMNS)} from app.approval_workflows where "id" = ${workflowId}::uuid and "businessId" = ${businessId}::uuid`.execute(context.transaction);
  const hydrated = await hydrateWorkflows(context, result.rows);
  return hydrated[0];
}

/** The one active workflow covering `type` (its own type or 'all'), or undefined if none — mirrors legacy's findActiveWorkflow. */
export async function findActiveWorkflow(context: DatabaseContext, businessId: string, type: Exclude<WorkflowType, "all">): Promise<Workflow | undefined> {
  const result = await sql<WorkflowRow>`
    select ${sql.raw(WORKFLOW_COLUMNS)} from app.approval_workflows
    where "businessId" = ${businessId}::uuid and "status" = 'active' and "type" in (${type}, 'all')
    limit 1
  `.execute(context.transaction);
  const hydrated = await hydrateWorkflows(context, result.rows);
  return hydrated[0];
}

/** True if an active workflow already covers `type` — used for a friendly pre-check before the DB's partial unique index would otherwise reject with a raw conflict. */
export async function hasConflictingActiveWorkflow(context: DatabaseContext, businessId: string, type: WorkflowType, excludeWorkflowId?: string): Promise<boolean> {
  const coverageTypes = type === "all" ? ["withdrawal", "bill_payment", "all"] : [type, "all"];
  const result = await sql<{ id: string }>`
    select "id" from app.approval_workflows
    where "businessId" = ${businessId}::uuid and "status" = 'active' and "type" = any(${coverageTypes})
      and "id" <> coalesce(${excludeWorkflowId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
    limit 1
  `.execute(context.transaction);
  return result.rows.length > 0;
}

async function insertApprovers(context: DatabaseContext, table: "approval_workflow_submitters" | "approval_group_approvers", businessId: string, parentColumn: "workflowId" | "groupId", parentId: string, approvers: ApproverInput[]): Promise<void> {
  for (const approver of approvers) {
    await sql`
      insert into app.${sql.raw(table)} ("businessId", ${sql.raw(`"${parentColumn}"`)}, "userId", "email", "name", "role")
      values (${businessId}::uuid, ${parentId}::uuid, ${approver.userId ?? null}::uuid, ${approver.email ?? null}, ${approver.name}, ${approver.role ?? null})
    `.execute(context.transaction);
  }
}

async function insertRuleApprovers(context: DatabaseContext, businessId: string, ruleId: string, approvers: RuleApproverInput[]): Promise<void> {
  let position = 0;
  for (const approver of approvers) {
    await sql`
      insert into app.approval_rule_approvers ("businessId", "ruleId", "userId", "email", "name", "role", "position")
      values (${businessId}::uuid, ${ruleId}::uuid, ${approver.userId ?? null}::uuid, ${approver.email ?? null}, ${approver.name}, ${approver.role ?? null}, ${approver.position ?? position})
    `.execute(context.transaction);
    position += 1;
  }
}

async function insertGroupsAndRules(context: DatabaseContext, businessId: string, workflowId: string, groups: GroupInput[]): Promise<void> {
  let position = 0;
  for (const group of groups) {
    const groupRow = (
      await sql<{ id: string }>`
        insert into app.approval_groups ("businessId", "workflowId", "title", "subtitle", "position")
        values (${businessId}::uuid, ${workflowId}::uuid, ${group.title}, ${group.subtitle ?? null}, ${position})
        returning "id"
      `.execute(context.transaction)
    ).rows[0]!;
    position += 1;

    if (group.approvers?.length) await insertApprovers(context, "approval_group_approvers", businessId, "groupId", groupRow.id, group.approvers);

    for (const rule of group.rules ?? []) {
      const ruleRow = (
        await sql<{ id: string }>`
          insert into app.approval_rules ("businessId", "groupId", "rangeLabel", "description", "minAmountMinor", "maxAmountMinor", "requireAll", "sequential")
          values (
            ${businessId}::uuid, ${groupRow.id}::uuid, ${rule.rangeLabel}, ${rule.description ?? ""},
            ${rule.minAmountMinor ?? null}, ${rule.maxAmountMinor ?? null}, ${rule.requireAll ?? true}, ${rule.sequential ?? false}
          )
          returning "id"
        `.execute(context.transaction)
      ).rows[0]!;
      if (rule.approvers?.length) await insertRuleApprovers(context, businessId, ruleRow.id, rule.approvers);
    }
  }
}

export async function createWorkflow(
  context: DatabaseContext,
  businessId: string,
  userId: string,
  creator: { name: string; email: string; role: string },
  input: WorkflowInput,
): Promise<string> {
  const workflow = (
    await sql<{ id: string }>`
      insert into app.approval_workflows (
        "businessId", "name", "type", "triggerTitle", "triggerSubtitle", "noSelfApproval", "creatorName", "creatorEmail", "creatorRole", "createdBy"
      ) values (
        ${businessId}::uuid, ${input.name}, ${input.type}, ${input.triggerTitle ?? null}, ${input.triggerSubtitle ?? null},
        ${input.noSelfApproval ?? true}, ${creator.name}, ${creator.email}, ${creator.role}, ${userId}::uuid
      )
      returning "id"
    `.execute(context.transaction)
  ).rows[0]!;

  if (input.submitters?.length) await insertApprovers(context, "approval_workflow_submitters", businessId, "workflowId", workflow.id, input.submitters);
  if (input.groups?.length) await insertGroupsAndRules(context, businessId, workflow.id, input.groups);

  return workflow.id;
}

export async function updateWorkflow(context: DatabaseContext, businessId: string, workflowId: string, input: Partial<WorkflowInput>): Promise<boolean> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.type !== undefined) fields.push(sql`"type" = ${input.type}`);
  if (input.triggerTitle !== undefined) fields.push(sql`"triggerTitle" = ${input.triggerTitle}`);
  if (input.triggerSubtitle !== undefined) fields.push(sql`"triggerSubtitle" = ${input.triggerSubtitle}`);
  if (input.noSelfApproval !== undefined) fields.push(sql`"noSelfApproval" = ${input.noSelfApproval}`);

  if (fields.length > 0) {
    const result = await sql`update app.approval_workflows set ${sql.join(fields, sql`, `)} where "id" = ${workflowId}::uuid and "businessId" = ${businessId}::uuid returning "id"`.execute(context.transaction);
    if (result.rows.length === 0) return false;
  }

  if (input.submitters !== undefined) {
    await sql`delete from app.approval_workflow_submitters where "workflowId" = ${workflowId}::uuid`.execute(context.transaction);
    if (input.submitters.length) await insertApprovers(context, "approval_workflow_submitters", businessId, "workflowId", workflowId, input.submitters);
  }
  if (input.groups !== undefined) {
    await sql`delete from app.approval_groups where "workflowId" = ${workflowId}::uuid`.execute(context.transaction);
    if (input.groups.length) await insertGroupsAndRules(context, businessId, workflowId, input.groups);
  }

  return true;
}

export async function setWorkflowStatus(context: DatabaseContext, businessId: string, workflowId: string, status: "active" | "inactive"): Promise<boolean> {
  const result = await sql`update app.approval_workflows set "status" = ${status} where "id" = ${workflowId}::uuid and "businessId" = ${businessId}::uuid returning "id"`.execute(context.transaction);
  return result.rows.length > 0;
}

export async function deleteWorkflow(context: DatabaseContext, businessId: string, workflowId: string): Promise<boolean> {
  const result = await sql`delete from app.approval_workflows where "id" = ${workflowId}::uuid and "businessId" = ${businessId}::uuid returning "id"`.execute(context.transaction);
  return result.rows.length > 0;
}

export async function createApprovalRequest(
  context: DatabaseContext,
  businessId: string,
  input: {
    subjectType: SubjectType;
    subjectId: string;
    workflowId: string;
    workflowName: string;
    requestedBy: string;
    amountMinor: string;
    assetCode: string;
    steps: unknown;
    pendingApproverIds: string[];
    pendingPayload?: Record<string, unknown>;
  },
): Promise<string> {
  const result = await sql<{ id: string }>`
    insert into app.approval_requests (
      "businessId", "subjectType", "subjectId", "workflowId", "workflowName", "requestedBy", "amountMinor", "assetCode", "steps", "pendingApproverIds", "pendingPayload"
    ) values (
      ${businessId}::uuid, ${input.subjectType}, ${input.subjectId}::uuid, ${input.workflowId}::uuid, ${input.workflowName}, ${input.requestedBy}::uuid,
      ${input.amountMinor}::bigint, ${input.assetCode}, ${JSON.stringify(input.steps)}::jsonb, ${input.pendingApproverIds},
      ${input.pendingPayload ? JSON.stringify(input.pendingPayload) : null}::jsonb
    )
    returning "id"
  `.execute(context.transaction);
  return result.rows[0]!.id;
}

export async function findApprovalRequest(context: DatabaseContext, businessId: string, requestId: string): Promise<ApprovalRequestRow | undefined> {
  const result = await sql<ApprovalRequestRow>`
    select ${sql.raw(REQUEST_COLUMNS.replace('"amountMinor"', '"amountMinor"::text'))} from app.approval_requests
    where "id" = ${requestId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

/** Compare-and-swap: succeeds only if the row is still at `expectedVersion`. Returns undefined on a lost race — the caller re-reads and retries. */
export async function casUpdateApprovalRequest(
  context: DatabaseContext,
  requestId: string,
  expectedVersion: number,
  fields: { steps: unknown; status: string; pendingApproverIds: string[] },
): Promise<ApprovalRequestRow | undefined> {
  const result = await sql<ApprovalRequestRow>`
    update app.approval_requests set
      "steps" = ${JSON.stringify(fields.steps)}::jsonb,
      "status" = ${fields.status},
      "pendingApproverIds" = ${fields.pendingApproverIds},
      "version" = "version" + 1
    where "id" = ${requestId}::uuid and "version" = ${expectedVersion}
    returning ${sql.raw(REQUEST_COLUMNS.replace('"amountMinor"', '"amountMinor"::text'))}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listPendingForUser(context: DatabaseContext, businessId: string, userId: string): Promise<ApprovalRequestRow[]> {
  const result = await sql<ApprovalRequestRow>`
    select ${sql.raw(REQUEST_COLUMNS.replace('"amountMinor"', '"amountMinor"::text'))} from app.approval_requests
    where "businessId" = ${businessId}::uuid and "status" = 'pending' and ${userId}::uuid = any("pendingApproverIds")
    order by "createdAt"
  `.execute(context.transaction);
  return result.rows;
}
