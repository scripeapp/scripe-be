-- The audit domain's LogAuditEventInput has always typed businessId as
-- string | null (for actions with no business, e.g. "not exposed via any
-- route" system/platform actions), but no caller ever actually logged a
-- null-businessId event until the platform domain's admin actions did.
-- Postgres re-checks a table's SELECT policy against an INSERT ... RETURNING
-- row, and the original policy required businessId is not null, so that
-- first real null-businessId write failed RLS on its own RETURNING clause.
-- This is a gap in already-shipped behavior, not a redesign: it extends the
-- same policy to the case its own input type already promised.
drop policy audit_events_read on app.audit_events;

create policy audit_events_read on app.audit_events for select
  using (
    ("businessId" is not null and app.has_business_permission("businessId", 'audit.read'))
    or ("businessId" is null and app.is_platform_administrator())
  );
