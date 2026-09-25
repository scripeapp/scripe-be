-- Links a confirmed avatar upload to a user profile, and exposes a
-- SECURITY DEFINER lookup so any viewer (not just the owner) can resolve
-- the object key behind someone's public avatar. Uploads are private and
-- owner-only under RLS (rules.md D, migration 0026) — a plain select from
-- app.uploads as any other viewer returns nothing, so this narrowly-scoped
-- function is the only path a public avatar route can use, and it exposes
-- nothing beyond the one object key for one confirmed avatar upload.

alter table app.user_profiles
    add column "avatarUploadId" uuid references app.uploads ("id") on delete set null;

create or replace function app.get_confirmed_avatar_object_key(target_user_id uuid)
returns text
language sql stable security definer
set search_path = app, pg_temp
as $$
  select upload."objectKey"
  from app.user_profiles profile
  join app.uploads upload on upload."id" = profile."avatarUploadId"
  where profile."userId" = target_user_id
    and upload."userId" = target_user_id
    and upload."purpose" = 'avatar'
    and upload."status" = 'confirmed';
$$;

revoke all on function app.get_confirmed_avatar_object_key(uuid) from public;
grant execute on function app.get_confirmed_avatar_object_key(uuid) to scripe_app;
