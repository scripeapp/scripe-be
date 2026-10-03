-- 0090_app_single_logo.sql
-- One logo instead of a wide logo plus a square icon. Nearly every place a
-- business's logo appears is a square or circle (storefront avatar, receipts,
-- invoice and email headers), so a second, wide image only confused people.
-- Where a business uploaded the square icon, it becomes the logo, since it's
-- the one that fits those places.

update app.uploads u set "purpose" = 'business_logo'
from app.businesses b
where b."iconUploadId" = u."id" and u."purpose" = 'business_icon';

update app.businesses set "logoUploadId" = "iconUploadId" where "iconUploadId" is not null;

update app.uploads set "purpose" = 'other' where "purpose" = 'business_icon';

drop function app.get_business_branding(uuid);

create function app.get_business_branding(target_business_id uuid)
returns table (
  "businessId" uuid,
  "displayName" text,
  "brandColor" text,
  "logoUploadId" uuid,
  "logoObjectKey" text,
  "coverUploadId" uuid,
  "coverObjectKey" text
)
language sql stable security definer
set search_path = ''
as $$
  select
    b."id", b."displayName", b."brandColor",
    logo."id", logo."objectKey",
    cover."id", cover."objectKey"
  from app.businesses b
  left join app.uploads logo on logo."id" = b."logoUploadId" and logo."businessId" = b."id"
    and logo."purpose" = 'business_logo' and logo."status" = 'confirmed'
  left join app.uploads cover on cover."id" = b."coverUploadId" and cover."businessId" = b."id"
    and cover."purpose" = 'business_cover' and cover."status" = 'confirmed'
  where b."id" = target_business_id and b."status" <> 'archived';
$$;

revoke all on function app.get_business_branding(uuid) from public;
grant execute on function app.get_business_branding(uuid) to scripe_app;

alter table app.businesses drop column "iconUploadId";

alter table app.uploads drop constraint "uploads_purpose_check";
alter table app.uploads add constraint "uploads_purpose_check"
  check ("purpose" in ('product_image', 'compliance_document', 'avatar', 'business_logo', 'business_cover', 'other'));
