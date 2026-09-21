drop function if exists app.mark_virtual_account_status_from_webhook(text, text, text, text, text);
drop function if exists app.mark_banking_kyc_status_from_webhook(text, text, text);
drop function if exists app.fail_checkout_payment_from_webhook(text);
drop function if exists app.capture_checkout_payment_from_webhook(text);
drop table if exists app.provider_events;
