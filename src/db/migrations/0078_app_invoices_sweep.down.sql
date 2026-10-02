-- 0078_app_invoices_sweep.down.sql

drop function if exists app.record_invoice_sweep_reminder_sent(uuid);
drop function if exists app.list_overdue_invoices_for_sweep();
