-- Fix the public reserve function: the PL/pgSQL variable v_id conflicts with the
-- OUT column "id" of the RETURNS TABLE(...) signature, making RETURNING "id"
-- ambiguous (SQLSTATE 42702 "column reference is ambiguous"). Qualify it with
-- the table name so the inserted booking's id actually returns.
--
-- 0061 shipped with this flaw; the function compiled but every reservation
-- failed. 0062 replaces it in place.

create or replace function app.reserve_booking_from_public(
  target_store_id uuid,
  target_product_id uuid,
  target_variant_id uuid,
  target_staff_id uuid,
  target_location_id uuid,
  target_starts_at timestamptz,
  target_customer_name text default null,
  target_customer_email text default null,
  target_customer_phone text default null,
  target_manage_token text default null,
  target_hold_minutes integer default 10
)
returns table (
  "id" uuid,
  "startsAt" timestamptz,
  "endsAt" timestamptz,
  "holdExpiresAt" timestamptz,
  "error" text
)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
  v_product_type text;
  v_base_duration integer;
  v_duration integer;
  v_min_notice integer;
  v_max_advance integer;
  v_starts timestamptz;
  v_ends timestamptz;
  v_hold_expires timestamptz;
  v_id uuid;
begin
  select s."businessId" into v_business_id
  from app.stores s
  where s."id" = target_store_id and s."status" = 'active';
  if v_business_id is null then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'store_inactive';
    return;
  end if;

  select p."productType", pss."durationMinutes", pss."minNoticeMinutes", pss."maxAdvanceDays"
    into v_product_type, v_base_duration, v_min_notice, v_max_advance
  from app.products p
  left join app.product_service_settings pss on pss."productId" = p."id"
  where p."id" = target_product_id
    and p."businessId" = v_business_id
    and p."productType" = 'service';
  if v_product_type is null then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'product_not_service';
    return;
  end if;

  if not exists (
    select 1 from app.staff_profiles sp
    where sp."id" = target_staff_id
      and sp."businessId" = v_business_id
      and sp."isBookable"
  ) then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'staff_unavailable';
    return;
  end if;

  if not exists (
    select 1 from app.staff_services ss
    where ss."staffId" = target_staff_id
      and ss."businessId" = v_business_id
      and ss."productId" = target_product_id
      and (target_variant_id is null or ss."variantId" is null or ss."variantId" = target_variant_id)
  ) then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'staff_does_not_perform';
    return;
  end if;

  if target_location_id is not null and not exists (
    select 1 from app.locations loc
    where loc."id" = target_location_id and loc."businessId" = v_business_id
  ) then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'location_unknown';
    return;
  end if;

  select ss."durationOverrideMinutes" into v_duration
  from app.staff_services ss
  where ss."staffId" = target_staff_id
    and ss."businessId" = v_business_id
    and ss."productId" = target_product_id
    and (target_variant_id is null or ss."variantId" is null or ss."variantId" = target_variant_id)
  order by (ss."variantId" is not null) desc, (ss."variantId" = target_variant_id) desc
  limit 1;
  v_duration := coalesce(v_duration, v_base_duration);

  v_starts := date_trunc('minute', target_starts_at);
  v_ends := v_starts + (v_duration * interval '1 minute');
  v_hold_expires := now() + (greatest(1, coalesce(target_hold_minutes, 10)) * interval '1 minute');

  if v_starts < now() + (coalesce(v_min_notice, 0) * interval '1 minute') then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'too_late';
    return;
  end if;
  if v_starts > now() + (coalesce(v_max_advance, 60) * interval '1 day') then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'too_far';
    return;
  end if;

  insert into app.bookings (
    "businessId", "storeId", "locationId", "customerName", "customerEmail", "customerPhone",
    "status", "source", "startsAt", "endsAt", "holdExpiresAt", "manageToken", "initiatedBy"
  ) values (
    v_business_id, target_store_id, target_location_id,
    nullif(trim(coalesce(target_customer_name, '')), ''),
    nullif(trim(coalesce(target_customer_email, '')), ''),
    nullif(trim(coalesce(target_customer_phone, '')), ''),
    'held', 'online', v_starts, v_ends, v_hold_expires, target_manage_token, 'customer'
  )
  returning app.bookings."id" into v_id;

  begin
    insert into app.booking_items (
      "businessId", "bookingId", "position", "productId", "variantId", "staffId",
      "startsAt", "endsAt", "modifierOptionIds", "priceMinor", "durationMinutes", "status"
    ) values (
      v_business_id, v_id, 0, target_product_id, target_variant_id, target_staff_id,
      v_starts, v_ends, '{}'::uuid[], 0, v_duration, 'held'
    );
  exception
    when exclusion_violation then
      delete from app.bookings where "id" = v_id;
      return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'slot_taken';
      return;
  end;

  return query select v_id, v_starts, v_ends, v_hold_expires, null::text;
end;
$$;

revoke all on function app.reserve_booking_from_public(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, text, text, integer) from public;
grant execute on function app.reserve_booking_from_public(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, text, text, integer) to scripe_app;