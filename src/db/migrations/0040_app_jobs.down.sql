drop function if exists app.ensure_recurring_job(text, integer);
drop function if exists app.expire_stale_pending_uploads(timestamptz);
drop function if exists app.finish_job(uuid, boolean, text, timestamptz);
drop function if exists app.claim_due_jobs(integer, integer, text);
drop table if exists app.job_attempts;
drop table if exists app.jobs;

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('jobs.read', 'jobs.manage')
);
delete from app.permissions where "code" in ('jobs.read', 'jobs.manage');
