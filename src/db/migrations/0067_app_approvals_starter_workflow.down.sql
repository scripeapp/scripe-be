-- Removes starter workflows nobody has touched: still switched off, still a
-- starter's name, type and trigger, never edited since creation. Groups,
-- approvers and rules go with them (on delete cascade). Workflows a business
-- has edited or switched on are kept. This cannot tell backfilled starters
-- from ones seeded at business creation, so both are removed alike.
delete from app.approval_workflows
where "status" = 'inactive'
  and "updatedAt" = "createdAt"
  and (
    ("name" = 'Bills' and "type" = 'bill_payment' and "triggerTitle" = 'Bills Submitted')
    or ("name" = 'Transfers' and "type" = 'withdrawal' and "triggerTitle" = 'Transfers Initiated')
  );
