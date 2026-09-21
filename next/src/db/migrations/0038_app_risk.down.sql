drop function if exists app.has_active_transaction_hold(text, uuid);
drop table if exists app.transaction_holds;
alter table app.risk_signals drop constraint if exists risk_signals_case_fk;
drop table if exists app.risk_cases;
drop table if exists app.risk_signals;
