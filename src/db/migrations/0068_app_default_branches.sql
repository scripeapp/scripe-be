-- Every store now starts with a default branch named after its business
-- (createDefaultBranch in stores.service.ts, called when a business or a
-- store is created), so location-scoped features - stock, per-branch prices,
-- the delivery pickup address, staff hours - always have somewhere to attach.
-- This backfills every store that has no live branch yet. A business's
-- default store also takes the business's address, when it has one; other
-- stores' branches start without an address.

insert into app.locations (
  "businessId", "storeId", "name", "kind", "status", "isDefault", "countryCode", "timezone",
  "addressLine1", "addressLine2", "city", "state", "postalCode"
)
select
  store."businessId", store."id", business."displayName", 'branch', 'active', true, 'NG', store."timezone",
  case when store."isDefault" then nullif(trim(business."addressLine1"), '') end,
  case when store."isDefault" and nullif(trim(business."addressLine1"), '') is not null then business."addressLine2" end,
  case when store."isDefault" and nullif(trim(business."addressLine1"), '') is not null then business."city" end,
  case when store."isDefault" and nullif(trim(business."addressLine1"), '') is not null then business."state" end,
  case when store."isDefault" and nullif(trim(business."addressLine1"), '') is not null then business."postalCode" end
from app.stores store
join app.businesses business on business."id" = store."businessId"
where store."status" <> 'archived'
  and not exists (
    select 1 from app.locations existing
    where existing."storeId" = store."id" and existing."status" <> 'archived'
  );
