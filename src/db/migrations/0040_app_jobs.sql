-- Jobs: a durable, one-shot, retryable async work queue. Ported in spirit
-- from legacy's two separate mechanisms - src/services/scheduler.service.ts
-- (1,549 lines of in-process node-cron recurring sweeps) and
-- src/config/qstash.ts (Upstash-queued one-off jobs like video processing
-- and campaign sends) - but built as neither, since next/'s server is a
-- persistent long-running process (src/server.ts's app.listen(), no
-- vercel.json), unlike a serverless deployment that would force an
-- externally-triggered-HTTP design. A durable table + an in-process poller
-- (registered from server.ts, not app.ts, so it never runs under the test
-- harness) covers both legacy shapes: a one-shot job, and a recurring sweep
-- implemented as a job that reschedules itself on success.
--
-- Most of legacy's ~20 named cron jobs target domains that are either not
-- yet built (subscriptions, campaigns) or explicitly excluded (posts,
-- publications) - this slice does not invent handlers for those. It wires
-- exactly one real, already-evidenced task: expiring stale pending
-- uploads, which the uploads domain's own migration (0026) already left a
-- named breadcrumb for - `uploads_pending_idx`'s comment reads "For a
-- future worker-role orphan-cleanup job (rules.md E) — not built in this
-- slice." rules.md section E states this outright: "Orphan cleanup runs
-- as the worker role."
--
-- Scheduling/claiming/finishing all go through security-definer functions:
-- an in-process poller calling these has no request-scoped caller identity
-- (no user, no business) - the same anonymous-background-actor problem
-- every webhook handler in this codebase already solves the same way.

insert into app.permissions ("code", "description") values
  ('jobs.read', 'View scheduled and running background jobs'),
  ('jobs.manage', 'Cancel or manually re-run background jobs')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('jobs.read', 'jobs.manage')
on conflict do nothing;

create table app.jobs (
  "id" uuid primary key default gen_random_uuid(),
  "type" text not null check (length(trim("type")) between 1 and 100),
  "payload" jsonb not null default '{}'::jsonb check (jsonb_typeof("payload") = 'object'),
  "status" text not null default 'pending' check ("status" in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  "runAt" timestamptz not null default now(),
  "attempts" integer not null default 0 check ("attempts" >= 0),
  "maxAttempts" integer not null default 5 check ("maxAttempts" > 0),
  "lastError" text,
  "lockedBy" text,
  "lockedUntil" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index jobs_due_idx on app.jobs ("runAt") where "status" = 'pending';
create index jobs_type_idx on app.jobs ("type", "status", "createdAt" desc);

create trigger jobs_set_updated_at before update on app.jobs
  for each row execute function app.set_updated_at();

alter table app.jobs enable row level security;
create policy jobs_read on app.jobs for select
  using (app.is_platform_administrator());
create policy jobs_update on app.jobs for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());
-- Scheduled by any domain's server-side code about a future task, not the
-- caller's own identity - same insert shape as audit_events/admin_alerts/
-- risk_signals.
create policy jobs_insert on app.jobs for insert with check (true);

grant select, insert, update on app.jobs to scripe_app;

create table app.job_attempts (
  "id" uuid primary key default gen_random_uuid(),
  "jobId" uuid not null references app.jobs ("id") on delete cascade,
  "attemptNumber" integer not null check ("attemptNumber" > 0),
  "status" text not null check ("status" in ('succeeded', 'failed')),
  "error" text,
  "startedAt" timestamptz not null,
  "finishedAt" timestamptz not null default now()
);

create index job_attempts_job_idx on app.job_attempts ("jobId", "attemptNumber");

create trigger job_attempts_immutable before update or delete on app.job_attempts
  for each row execute function app.reject_immutable_change();

alter table app.job_attempts enable row level security;
create policy job_attempts_read on app.job_attempts for select
  using (app.is_platform_administrator());
create policy job_attempts_insert on app.job_attempts for insert with check (true);

grant select, insert on app.job_attempts to scripe_app;

-- Atomically claims up to p_limit due jobs (pending and due, or running
-- past a dead lease) under FOR UPDATE SKIP LOCKED, so concurrent poller
-- ticks - or a future multi-instance deployment - never double-claim a
-- job. security definer since the in-process poller has no caller identity
-- RLS could authorize.
create or replace function app.claim_due_jobs(p_limit integer, p_lease_seconds integer, p_worker text)
returns setof app.jobs
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
begin
  return query
    update app.jobs set "status" = 'running', "attempts" = "attempts" + 1, "lockedBy" = p_worker, "lockedUntil" = now() + make_interval(secs => p_lease_seconds)
    where "id" in (
      select job."id" from app.jobs job
      where (job."status" = 'pending' and job."runAt" <= now())
         or (job."status" = 'running' and job."lockedUntil" < now())
      order by job."runAt"
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

revoke all on function app.claim_due_jobs(integer, integer, text) from public;
grant execute on function app.claim_due_jobs(integer, integer, text) to scripe_app;

-- Records the attempt and transitions the job: succeeded with a
-- next-run-at reschedules to pending (the self-perpetuating-recurring-job
-- shape); succeeded with no next-run-at is terminal; failed under
-- maxAttempts reschedules with exponential backoff; failed at maxAttempts
-- is terminal.
create or replace function app.finish_job(p_job_id uuid, p_succeeded boolean, p_error text, p_next_run_at timestamptz)
returns void
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
begin
  select job."attempts", job."maxAttempts" into v_attempts, v_max_attempts from app.jobs job where job."id" = p_job_id for update;
  if not found then
    return;
  end if;

  insert into app.job_attempts ("jobId", "attemptNumber", "status", "error", "startedAt")
    values (p_job_id, v_attempts, case when p_succeeded then 'succeeded' else 'failed' end, p_error, now());

  if p_succeeded then
    if p_next_run_at is not null then
      update app.jobs set "status" = 'pending', "runAt" = p_next_run_at, "attempts" = 0, "lastError" = null, "lockedBy" = null, "lockedUntil" = null where "id" = p_job_id;
    else
      update app.jobs set "status" = 'succeeded', "lockedBy" = null, "lockedUntil" = null where "id" = p_job_id;
    end if;
    return;
  end if;

  if v_attempts >= v_max_attempts then
    update app.jobs set "status" = 'failed', "lastError" = p_error, "lockedBy" = null, "lockedUntil" = null where "id" = p_job_id;
  else
    update app.jobs set "status" = 'pending', "runAt" = now() + make_interval(secs => least(power(2, v_attempts)::integer * 30, 3600)), "lastError" = p_error, "lockedBy" = null, "lockedUntil" = null
      where "id" = p_job_id;
  end if;
end;
$$;

revoke all on function app.finish_job(uuid, boolean, text, timestamptz) from public;
grant execute on function app.finish_job(uuid, boolean, text, timestamptz) to scripe_app;

-- The one concrete wired task this slice ships: uploads left pending (never
-- confirmed) past the cutoff are marked failed, freeing them from lingering
-- forever - the job uploads_pending_idx's own comment was written for.
create or replace function app.expire_stale_pending_uploads(p_cutoff timestamptz)
returns integer
language sql volatile security definer
set search_path = app, pg_temp
as $$
  with updated as (
    update app.uploads upload set "status" = 'failed'
    where upload."status" = 'pending' and upload."createdAt" < p_cutoff
    returning 1
  )
  select count(*)::integer from updated;
$$;

revoke all on function app.expire_stale_pending_uploads(timestamptz) from public;
grant execute on function app.expire_stale_pending_uploads(timestamptz) to scripe_app;

-- Idempotent bootstrap for a built-in recurring job (e.g. the upload
-- expiry sweep) seeded on every server start: security definer since the
-- seeding code has no caller identity to pass has_business_permission
-- (there is none - this table isn't business-scoped), and RLS would
-- otherwise hide any existing pending/running row from a plain
-- existence-check SELECT, making a naive check-then-insert always
-- (wrongly) insert a duplicate.
create or replace function app.ensure_recurring_job(p_type text, p_max_attempts integer)
returns void
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
begin
  if not exists (select 1 from app.jobs job where job."type" = p_type and job."status" in ('pending', 'running')) then
    insert into app.jobs ("type", "maxAttempts") values (p_type, p_max_attempts);
  end if;
end;
$$;

revoke all on function app.ensure_recurring_job(text, integer) from public;
grant execute on function app.ensure_recurring_job(text, integer) to scripe_app;
