-- capture_checkout_payment_from_webhook's widened signature is left in
-- place on rollback (same precedent as 0037's own down migration for a
-- create-or-replace-only change) - it doesn't reference any table this
-- migration drops, so there's nothing to restore.

drop function if exists app.post_journal_entry(uuid, date, text, text, text, uuid, uuid, jsonb);
drop table if exists app.journal_lines;
drop table if exists app.journal_entries;
drop table if exists app.accounting_periods;
drop table if exists app.ledger_accounts;

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('accounting.read', 'accounting.manage')
);
delete from app.permissions where "code" in ('accounting.read', 'accounting.manage');
