drop function if exists app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text);
drop function if exists app.mark_withdrawal_status_from_webhook(text, text, text);
drop function if exists app.issue_receipt_from_webhook(uuid, uuid);
alter table app.fiscal_documents alter column "createdBy" set not null;
