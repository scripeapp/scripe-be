-- Uploads: R2 object metadata, confirmation state, and processing job
-- records. Built as a live integration (src/integrations/r2.ts) per product
-- decision — unlike payments/compliance, a fake presigned URL here would be
-- actively misleading rather than a reasonable provider-neutral stand-in.
-- Domain tables reference confirmed upload IDs; provider URLs and
-- unvalidated client-supplied object keys are never persisted as domain
-- truth (this file's own description in PROPOSED_TABLE_INVENTORY.md).

insert into app.permissions ("code", "description") values
  ('upload.manage', 'Create and manage business-scoped uploads')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" = 'upload.manage'
on conflict do nothing;

create table app.uploads (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid references app.businesses ("id") on delete restrict,
  "userId" uuid not null references auth.user ("id") on delete restrict,
  "purpose" text not null check ("purpose" in ('product_image', 'compliance_document', 'avatar', 'other')),
  "objectKey" text not null unique,
  "mimeType" text not null,
  "sizeBytes" bigint not null check ("sizeBytes" > 0),
  "checksum" text,
  "status" text not null default 'pending' check ("status" in ('pending', 'confirmed', 'failed', 'deleted')),
  "retentionUntil" timestamptz,
  "createdAt" timestamptz not null default now(),
  "confirmedAt" timestamptz,
  "deletedAt" timestamptz
);

create index uploads_business_idx on app.uploads ("businessId", "createdAt" desc) where "businessId" is not null;
create index uploads_user_idx on app.uploads ("userId", "createdAt" desc);
create index uploads_pending_idx on app.uploads ("createdAt") where "status" = 'pending';
comment on index app.uploads_pending_idx is 'For a future worker-role orphan-cleanup job (rules.md E) — not built in this slice.';

create table app.upload_processing_jobs (
  "id" uuid primary key default gen_random_uuid(),
  "uploadId" uuid not null references app.uploads ("id") on delete cascade,
  "type" text not null check ("type" in ('virus_scan', 'document_extraction', 'video_processing')),
  "status" text not null default 'pending' check ("status" in ('pending', 'running', 'succeeded', 'failed')),
  "resultSummary" jsonb not null default '{}'::jsonb check (jsonb_typeof("resultSummary") = 'object'),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index upload_processing_jobs_upload_idx on app.upload_processing_jobs ("uploadId", "createdAt" desc);
create trigger upload_processing_jobs_set_updated_at before update on app.upload_processing_jobs
  for each row execute function app.set_updated_at();
comment on table app.upload_processing_jobs is 'Schema only in this slice — no virus-scan/extraction/video-processing integration exists yet, and nothing writes to this table.';

alter table app.uploads enable row level security;
alter table app.upload_processing_jobs enable row level security;

-- An upload is either business-scoped (gated by upload.manage) or personal
-- (businessId null, gated by ownership) — never both, and never neither.
create policy uploads_select on app.uploads for select
  using (
    ("businessId" is not null and app.has_business_permission("businessId", 'upload.manage'))
    or ("businessId" is null and app.current_user_id() = "userId"::text)
  );
create policy uploads_insert on app.uploads for insert
  with check (
    ("businessId" is not null and app.has_business_permission("businessId", 'upload.manage'))
    or ("businessId" is null and app.current_user_id() = "userId"::text)
  );
create policy uploads_update on app.uploads for update
  using (
    ("businessId" is not null and app.has_business_permission("businessId", 'upload.manage'))
    or ("businessId" is null and app.current_user_id() = "userId"::text)
  )
  with check (
    ("businessId" is not null and app.has_business_permission("businessId", 'upload.manage'))
    or ("businessId" is null and app.current_user_id() = "userId"::text)
  );

create policy upload_processing_jobs_select on app.upload_processing_jobs for select
  using (exists (
    select 1 from app.uploads upload where upload."id" = "uploadId"
      and (
        (upload."businessId" is not null and app.has_business_permission(upload."businessId", 'upload.manage'))
        or (upload."businessId" is null and app.current_user_id() = upload."userId"::text)
      )
  ));
create policy upload_processing_jobs_insert on app.upload_processing_jobs for insert
  with check (exists (
    select 1 from app.uploads upload where upload."id" = "uploadId"
      and (
        (upload."businessId" is not null and app.has_business_permission(upload."businessId", 'upload.manage'))
        or (upload."businessId" is null and app.current_user_id() = upload."userId"::text)
      )
  ));

grant select, insert, update on app.uploads to scripe_app;
grant select, insert on app.upload_processing_jobs to scripe_app;
