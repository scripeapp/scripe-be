-- 0090_app_single_logo.down.sql
-- Restores the icon column and function shape; the icon images themselves
-- stay merged into the logo.
alter table app.uploads drop constraint "uploads_purpose_check";
alter table app.uploads add constraint "uploads_purpose_check"
  check ("purpose" in ('product_image', 'compliance_document', 'avatar', 'business_logo', 'business_icon', 'business_cover', 'other'));

alter table app.businesses
  add column "iconUploadId" uuid references app.uploads ("id") on delete set null;

drop function app.get_business_branding(uuid);

create function app.get_business_branding(target_business_id uuid)
returns table (
  "businessId" uuid,
  "displayName" text,
  "brandColor" text,
  "logoUploadId" uuid,
  "logoObjectKey" text,
  "iconUploadId" uuid,
  "iconObjectKey" text,
  "coverUploadId" uuid,
  "coverObjectKey" text
)
language sql stable security definer
set search_path = ''
as $$
  select
    b."id", b."displayName", b."brandColor",
    logo."id", logo."objectKey",
    icon."id", icon."objectKey",
    cover."id", cover."objectKey"
  from app.businesses b
  left join app.uploads logo on logo."id" = b."logoUploadId" and logo."businessId" = b."id"
    and logo."purpose" = 'business_logo' and logo."status" = 'confirmed'
  left join app.uploads icon on icon."id" = b."iconUploadId" and icon."businessId" = b."id"
    and icon."purpose" = 'business_icon' and icon."status" = 'confirmed'
  left join app.uploads cover on cover."id" = b."coverUploadId" and cover."businessId" = b."id"
    and cover."purpose" = 'business_cover' and cover."status" = 'confirmed'
  where b."id" = target_business_id and b."status" <> 'archived';
$$;

revoke all on function app.get_business_branding(uuid) from public;
grant execute on function app.get_business_branding(uuid) to scripe_app;
