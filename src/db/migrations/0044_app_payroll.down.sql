drop table if exists app.payroll_items;
drop table if exists app.payroll_runs;

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('payroll.read', 'payroll.manage')
);
delete from app.permissions where "code" in ('payroll.read', 'payroll.manage');
