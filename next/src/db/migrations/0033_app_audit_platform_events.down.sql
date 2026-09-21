drop policy audit_events_read on app.audit_events;

create policy audit_events_read on app.audit_events for select
  using ("businessId" is not null and app.has_business_permission("businessId", 'audit.read'));
