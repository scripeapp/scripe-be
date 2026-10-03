-- 0088_app_storefront_profile.down.sql
drop function app.get_business_branding(uuid);

create function app.get_business_branding(target_business_id uuid)
returns table (
  "businessId" uuid,
  "displayName" text,
  "brandColor" text,
  "accentColor" text,
  "logoUploadId" uuid,
  "logoObjectKey" text,
  "iconUploadId" uuid,
  "iconObjectKey" text
)
language sql stable security definer
set search_path = ''
as $$
  select
    b."id", b."displayName", b."brandColor", b."accentColor",
    logo."id", logo."objectKey",
    icon."id", icon."objectKey"
  from app.businesses b
  left join app.uploads logo on logo."id" = b."logoUploadId" and logo."businessId" = b."id"
    and logo."purpose" = 'business_logo' and logo."status" = 'confirmed'
  left join app.uploads icon on icon."id" = b."iconUploadId" and icon."businessId" = b."id"
    and icon."purpose" = 'business_icon' and icon."status" = 'confirmed'
  where b."id" = target_business_id and b."status" <> 'archived';
$$;

revoke all on function app.get_business_branding(uuid) from public;
grant execute on function app.get_business_branding(uuid) to scripe_app;

alter table app.stores
  drop column "location",
  drop column "websiteUrl",
  drop column "socialLinks",
  drop column "businessHours",
  drop column "privacyPolicy",
  drop column "refundPolicy",
  drop column "productBrowsingMode";

alter table app.businesses drop column "coverUploadId";

update app.uploads set "purpose" = 'other' where "purpose" = 'business_cover';
alter table app.uploads drop constraint "uploads_purpose_check";
alter table app.uploads add constraint "uploads_purpose_check"
  check ("purpose" in ('product_image', 'compliance_document', 'avatar', 'business_logo', 'business_icon', 'other'));
