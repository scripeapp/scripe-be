alter table app.withdrawals drop constraint if exists withdrawals_status_check;
alter table app.withdrawals add constraint withdrawals_status_check
  check ("status" in ('pending', 'processing', 'success', 'failed'));

drop table if exists app.approval_requests;
drop table if exists app.approval_rule_approvers;
drop table if exists app.approval_rules;
drop table if exists app.approval_group_approvers;
drop table if exists app.approval_groups;
drop table if exists app.approval_workflow_submitters;
drop table if exists app.approval_workflows;
