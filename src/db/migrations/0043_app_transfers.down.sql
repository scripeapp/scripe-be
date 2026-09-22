drop table if exists app.transfer_attempts;
drop table if exists app.transfers;
drop table if exists app.beneficiaries;

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('transfers.read', 'transfers.manage')
);
delete from app.permissions where "code" in ('transfers.read', 'transfers.manage');
