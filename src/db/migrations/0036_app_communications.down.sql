drop table if exists app.communication_deliveries;
drop table if exists app.communication_messages;
drop function if exists app.complete_communication_credit_topup(text);
drop function if exists app.fail_communication_credit_topup(text);
drop table if exists app.communication_credit_topups;
drop table if exists app.communication_credit_entries;
drop table if exists app.communication_credit_accounts;
drop table if exists app.communication_opt_outs;
drop table if exists app.communication_audience_segment_members;
drop table if exists app.communication_audience_segments;
drop table if exists app.communication_templates;
drop table if exists app.communication_senders;
drop table if exists app.communication_domains;

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('communications.read', 'communications.manage')
);
delete from app.permissions where "code" in ('communications.read', 'communications.manage');
