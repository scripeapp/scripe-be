-- 0077_app_invoices_public_payment.down.sql

drop function if exists app.record_public_invoice_payment(text, text, text, text);
drop function if exists app.get_public_invoice_payment_target(text);
