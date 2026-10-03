-- 0088_app_storefront_profile.sql
-- What a storefront shows about the shop beyond its name and contact details:
-- a banner image, where it is, its website and social links, opening hours,
-- privacy and refund policies, and how products open. Before this the store
-- Customise screen kept all of it in the browser and saved none of it, so
-- public storefronts always showed those sections empty.
--
-- The banner is business branding, next to the logo and icon (purpose
-- business_cover), and public pages reach it through
-- app.get_business_branding like the other two images.

alter table app.uploads drop constraint "uploads_purpose_check";
alter table app.uploads add constraint "uploads_purpose_check"
  check ("purpose" in ('product_image', 'compliance_document', 'avatar', 'business_logo', 'business_icon', 'business_cover', 'other'));

alter table app.businesses
  add column "coverUploadId" uuid references app.uploads ("id") on delete set null;

alter table app.stores
  add column "location" text check ("location" is null or length("location") <= 300),
  add column "websiteUrl" text check ("websiteUrl" is null or length("websiteUrl") <= 500),
  add column "socialLinks" jsonb not null default '{}'::jsonb check (jsonb_typeof("socialLinks") = 'object'),
  add column "businessHours" jsonb not null default '{}'::jsonb check (jsonb_typeof("businessHours") = 'object'),
  add column "privacyPolicy" text check ("privacyPolicy" is null or length("privacyPolicy") <= 20000),
  add column "refundPolicy" text check ("refundPolicy" is null or length("refundPolicy") <= 20000),
  add column "productBrowsingMode" text not null default 'full_page'
    check ("productBrowsingMode" in ('full_page', 'quick_view'));

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
  "iconObjectKey" text,
  "coverUploadId" uuid,
  "coverObjectKey" text
)
language sql stable security definer
set search_path = ''
as $$
  select
    b."id", b."displayName", b."brandColor", b."accentColor",
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
