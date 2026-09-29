-- Every business starts with two approval workflows, both switched off, with
-- its owner as the only approver: one for Bills, one for Transfers (see
-- seedStarterApprovalWorkflows in approvals.service.ts, which does this for
-- new businesses). This backfills businesses created before that existed.
-- The values mirror STARTER_WORKFLOWS in approvals.service.ts - change both
-- together.
--
-- Only businesses with no workflows at all are seeded: anyone who has
-- already set approvals up (or deleted theirs) keeps exactly what they have.
-- The owner is the earliest active member holding the system owner role;
-- a business without one is skipped rather than given an ownerless template.

with starters ("name", "type", "triggerTitle", "groupSubtitle") as (
  values
    ('Bills', 'bill_payment', 'Bills Submitted', 'All bills'),
    ('Transfers', 'withdrawal', 'Transfers Initiated', 'All transfers')
),
owners as (
  select distinct on (membership."businessId")
    membership."businessId",
    membership."userId",
    account."name" as "userName",
    account."email" as "userEmail"
  from app.business_memberships membership
  join app.membership_roles membership_role
    on membership_role."membershipId" = membership."id" and membership_role."businessId" = membership."businessId"
  join app.roles role on role."id" = membership_role."roleId" and role."code" = 'owner' and role."isSystem"
  join auth.user account on account."id" = membership."userId"
  where membership."status" = 'active'
    and not exists (select 1 from app.approval_workflows existing where existing."businessId" = membership."businessId")
  order by membership."businessId", membership."createdAt"
),
workflows as (
  insert into app.approval_workflows (
    "businessId", "name", "type", "status", "triggerTitle", "triggerSubtitle", "noSelfApproval",
    "creatorName", "creatorEmail", "creatorRole", "createdBy"
  )
  select owner."businessId", starter."name", starter."type", 'inactive', starter."triggerTitle", 'Anyone with payment access', true,
    owner."userName", owner."userEmail", 'owner', owner."userId"
  from owners owner
  cross join starters starter
  returning "id", "businessId", "type"
),
groups as (
  insert into app.approval_groups ("businessId", "workflowId", "title", "subtitle", "position")
  select workflow."businessId", workflow."id", 'Approval group 1', starter."groupSubtitle", 0
  from workflows workflow
  join starters starter on starter."type" = workflow."type"
  returning "id", "businessId"
),
approvers as (
  insert into app.approval_group_approvers ("businessId", "groupId", "userId", "email", "name", "role")
  select grp."businessId", grp."id", owner."userId", owner."userEmail", coalesce(nullif(owner."userName", ''), owner."userEmail"), 'Owner'
  from groups grp
  join owners owner on owner."businessId" = grp."businessId"
  returning "id"
)
insert into app.approval_rules ("businessId", "groupId", "rangeLabel", "description", "minAmountMinor", "maxAmountMinor", "requireAll", "sequential")
select "businessId", "id", 'Everything else', 'All approvers in this group must approve', null, null, true, false
from groups;
