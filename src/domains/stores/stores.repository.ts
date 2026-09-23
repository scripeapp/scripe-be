import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  CashMovementRow,
  CashMovementInput,
  ChannelInput,
  LocationInput,
  LocationRow,
  RegisterInput,
  RegisterRow,
  RegisterShiftRow,
  SalesChannelRow,
  StoreCreateInput,
  StoreRow,
  StoreUpdateInput,
} from "./stores.types.js";

export async function lockBusiness(
  context: DatabaseContext,
  businessId: string,
): Promise<void> {
  await sql`select "id" from app.businesses where "id" = ${businessId}::uuid for update`.execute(
    context.transaction,
  );
}

export async function lockStore(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<boolean> {
  const result = await sql<{ id: string }>`
    select "id" from app.stores
    where "businessId" = ${businessId}::uuid and "id" = ${storeId}::uuid
      and "status" <> 'archived'
    for update
  `.execute(context.transaction);
  return result.rows.length === 1;
}

export async function listStores(
  context: DatabaseContext,
  businessId: string,
): Promise<StoreRow[]> {
  const result = await sql<StoreRow>`
    select * from app.stores
    where "businessId" = ${businessId}::uuid and "status" <> 'archived'
    order by "isDefault" desc, "createdAt" asc, "id" asc
  `.execute(context.transaction);
  return result.rows;
}

export async function findStore(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<StoreRow | undefined> {
  const result = await sql<StoreRow>`
    select * from app.stores
    where "businessId" = ${businessId}::uuid and "id" = ${storeId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

/** Public lookup by slug, not scoped to a businessId — the caller doesn't know it yet, that's the point of resolving by slug. Relies entirely on stores_public_read (migration 0046) to keep this to "active" stores only. */
export async function findActiveStoreBySlug(
  context: DatabaseContext,
  slug: string,
): Promise<StoreRow | undefined> {
  const result = await sql<StoreRow>`
    select * from app.stores
    where "slug" = ${slug} and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createStore(
  context: DatabaseContext,
  businessId: string,
  userId: string,
  input: StoreCreateInput,
  isDefault: boolean,
): Promise<StoreRow> {
  const result = await sql<StoreRow>`
    insert into app.stores (
      "businessId", "name", "slug", "description", "isDefault", "sellsOnline",
      "sellsInPerson", "contactEmail", "contactPhone", "timezone", "createdBy"
    ) values (
      ${businessId}::uuid, ${input.name}, ${input.slug}, ${input.description}, ${isDefault},
      ${input.sellsOnline}, ${input.sellsInPerson}, ${input.contactEmail ?? null},
      ${input.contactPhone ?? null}, ${input.timezone}, ${userId}::uuid
    ) returning *
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function clearDefaultStore(
  context: DatabaseContext,
  businessId: string,
  exceptStoreId?: string,
): Promise<void> {
  await sql`
    update app.stores set "isDefault" = false
    where "businessId" = ${businessId}::uuid and "isDefault" = true
      and (${exceptStoreId ?? null}::uuid is null or "id" <> ${exceptStoreId ?? null}::uuid)
  `.execute(context.transaction);
}

export async function updateStore(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  input: StoreUpdateInput,
): Promise<StoreRow | undefined> {
  const assignments: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) assignments.push(sql`"name" = ${input.name}`);
  if (input.slug !== undefined) assignments.push(sql`"slug" = ${input.slug}`);
  if (input.description !== undefined)
    assignments.push(sql`"description" = ${input.description}`);
  if (input.isDefault !== undefined)
    assignments.push(sql`"isDefault" = ${input.isDefault}`);
  if (input.sellsOnline !== undefined)
    assignments.push(sql`"sellsOnline" = ${input.sellsOnline}`);
  if (input.sellsInPerson !== undefined)
    assignments.push(sql`"sellsInPerson" = ${input.sellsInPerson}`);
  if (input.contactEmail !== undefined)
    assignments.push(sql`"contactEmail" = ${input.contactEmail}`);
  if (input.contactPhone !== undefined)
    assignments.push(sql`"contactPhone" = ${input.contactPhone}`);
  if (input.timezone !== undefined)
    assignments.push(sql`"timezone" = ${input.timezone}`);
  if (input.status !== undefined)
    assignments.push(sql`"status" = ${input.status}`);
  const result = await sql<StoreRow>`
    update app.stores set ${sql.join(assignments, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${storeId}::uuid and "status" <> 'archived'
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}

export async function archiveStore(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<StoreRow | undefined> {
  const result = await sql<StoreRow>`
    update app.stores set "status" = 'archived', "isDefault" = false, "archivedAt" = now()
    where "businessId" = ${businessId}::uuid and "id" = ${storeId}::uuid and "status" <> 'archived'
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}

export async function promoteOldestStoreToDefault(
  context: DatabaseContext,
  businessId: string,
): Promise<void> {
  await sql`
    update app.stores set "isDefault" = true
    where "id" = (
      select "id" from app.stores where "businessId" = ${businessId}::uuid and "status" <> 'archived'
      order by "createdAt", "id" limit 1
    )
  `.execute(context.transaction);
}

export async function listLocations(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<LocationRow[]> {
  const result =
    await sql<LocationRow>`select * from app.locations where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "status" <> 'archived' order by "isDefault" desc, "createdAt", "id"`.execute(
      context.transaction,
    );
  return result.rows;
}

export async function createLocation(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  input: LocationInput,
  isDefault: boolean,
): Promise<LocationRow> {
  const result = await sql<LocationRow>`
    insert into app.locations ("businessId","storeId","name","kind","status","isDefault","addressLine1","addressLine2","city","state","postalCode","countryCode","latitude","longitude","phone","timezone","businessHours","prepTimeMinutes","operationTypes","acceptingOrders","taxRate","serviceChargeRates","manager","format")
    values (${businessId}::uuid,${storeId}::uuid,${input.name},${input.kind},${input.status},${isDefault},${input.addressLine1 ?? null},${input.addressLine2 ?? null},${input.city ?? null},${input.state ?? null},${input.postalCode ?? null},${input.countryCode},${input.latitude ?? null}::numeric,${input.longitude ?? null}::numeric,${input.phone ?? null},${input.timezone},${JSON.stringify(input.businessHours)}::jsonb,${input.prepTimeMinutes ?? null},${input.operationTypes ?? []},${input.acceptingOrders ?? true},${input.taxRate ?? 0},${JSON.stringify(input.serviceChargeRates ?? {})}::jsonb,${input.manager ?? null},${input.format ?? null}) returning *
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function clearDefaultLocation(
  context: DatabaseContext,
  storeId: string,
  exceptId?: string,
): Promise<void> {
  await sql`update app.locations set "isDefault"=false where "storeId"=${storeId}::uuid and "isDefault" and (${exceptId ?? null}::uuid is null or "id" <> ${exceptId ?? null}::uuid)`.execute(
    context.transaction,
  );
}

export async function updateLocation(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  locationId: string,
  input: Partial<LocationInput>,
): Promise<LocationRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  const values = input as Record<string, unknown>;
  for (const key of [
    "name",
    "kind",
    "status",
    "isDefault",
    "addressLine1",
    "addressLine2",
    "city",
    "state",
    "postalCode",
    "countryCode",
    "latitude",
    "longitude",
    "phone",
    "timezone",
    "prepTimeMinutes",
    "operationTypes",
    "acceptingOrders",
    "taxRate",
    "manager",
    "format",
  ] as const) {
    if (values[key] !== undefined)
      fields.push(sql`${sql.ref(key)} = ${values[key]}`);
  }
  if (input.businessHours !== undefined)
    fields.push(
      sql`"businessHours" = ${JSON.stringify(input.businessHours)}::jsonb`,
    );
  if (input.serviceChargeRates !== undefined)
    fields.push(
      sql`"serviceChargeRates" = ${JSON.stringify(input.serviceChargeRates)}::jsonb`,
    );
  const result =
    await sql<LocationRow>`update app.locations set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${locationId}::uuid and "status" <> 'archived' returning *`.execute(
      context.transaction,
    );
  return result.rows[0];
}

export async function archiveLocation(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  locationId: string,
): Promise<LocationRow | undefined> {
  const result =
    await sql<LocationRow>`update app.locations set "status"='archived', "isDefault"=false, "archivedAt"=now() where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${locationId}::uuid and "status" <> 'archived' returning *`.execute(
      context.transaction,
    );
  return result.rows[0];
}

export async function listChannels(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<SalesChannelRow[]> {
  return (
    await sql<SalesChannelRow>`select * from app.sales_channels where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "status" <> 'archived' order by "createdAt", "id"`.execute(
      context.transaction,
    )
  ).rows;
}

export async function createChannel(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  input: ChannelInput,
): Promise<SalesChannelRow> {
  return (
    await sql<SalesChannelRow>`insert into app.sales_channels ("businessId","storeId","code","name","kind","status") values (${businessId}::uuid,${storeId}::uuid,${input.code},${input.name},${input.kind},${input.status}) returning *`.execute(
      context.transaction,
    )
  ).rows[0]!;
}

export async function updateChannel(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  channelId: string,
  input: Partial<ChannelInput>,
): Promise<SalesChannelRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.code !== undefined) fields.push(sql`"code"=${input.code}`);
  if (input.name !== undefined) fields.push(sql`"name"=${input.name}`);
  if (input.kind !== undefined) fields.push(sql`"kind"=${input.kind}`);
  if (input.status !== undefined) fields.push(sql`"status"=${input.status}`);
  return (
    await sql<SalesChannelRow>`update app.sales_channels set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${channelId}::uuid and "status" <> 'archived' returning *`.execute(
      context.transaction,
    )
  ).rows[0];
}

export async function archiveChannel(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  channelId: string,
): Promise<SalesChannelRow | undefined> {
  return (
    await sql<SalesChannelRow>`update app.sales_channels set "status"='archived' where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${channelId}::uuid and "status" <> 'archived' returning *`.execute(
      context.transaction,
    )
  ).rows[0];
}

export async function listRegisters(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<RegisterRow[]> {
  return (
    await sql<RegisterRow>`select * from app.registers where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "status" <> 'archived' order by "createdAt", "id"`.execute(
      context.transaction,
    )
  ).rows;
}

export async function createRegister(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  input: RegisterInput,
): Promise<RegisterRow> {
  return (
    await sql<RegisterRow>`insert into app.registers ("businessId","storeId","locationId","name","status") values (${businessId}::uuid,${storeId}::uuid,${input.locationId}::uuid,${input.name},${input.status}) returning *`.execute(
      context.transaction,
    )
  ).rows[0]!;
}

export async function updateRegister(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  registerId: string,
  input: Partial<RegisterInput>,
): Promise<RegisterRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.locationId !== undefined)
    fields.push(sql`"locationId"=${input.locationId}::uuid`);
  if (input.name !== undefined) fields.push(sql`"name"=${input.name}`);
  if (input.status !== undefined) fields.push(sql`"status"=${input.status}`);
  return (
    await sql<RegisterRow>`update app.registers set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${registerId}::uuid and "status" <> 'archived' returning *`.execute(
      context.transaction,
    )
  ).rows[0];
}

export async function archiveRegister(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  registerId: string,
): Promise<RegisterRow | undefined> {
  return (
    await sql<RegisterRow>`update app.registers set "status"='archived', "archivedAt"=now() where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${registerId}::uuid and "status" <> 'archived' and not exists (select 1 from app.register_shifts shift where shift."registerId"=app.registers."id" and shift."status"='open') returning *`.execute(
      context.transaction,
    )
  ).rows[0];
}

export async function openShift(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  registerId: string,
  membershipId: string,
  openingCashMinor: string,
): Promise<RegisterShiftRow | undefined> {
  const result = await sql<RegisterShiftRow>`
    insert into app.register_shifts ("businessId","storeId","locationId","registerId","openedByMembershipId","openingCashMinor")
    select register."businessId", register."storeId", register."locationId", register."id", ${membershipId}::uuid, ${openingCashMinor}
    from app.registers register where register."businessId"=${businessId}::uuid and register."storeId"=${storeId}::uuid and register."id"=${registerId}::uuid and register."status"='active'
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findOpenShift(
  context: DatabaseContext,
  businessId: string,
  registerId: string,
): Promise<RegisterShiftRow | undefined> {
  return (
    await sql<RegisterShiftRow>`select * from app.register_shifts where "businessId"=${businessId}::uuid and "registerId"=${registerId}::uuid and "status"='open' limit 1`.execute(
      context.transaction,
    )
  ).rows[0];
}

export async function closeShift(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  shiftId: string,
  membershipId: string,
  countedCashMinor: string,
  notes?: string,
): Promise<RegisterShiftRow | undefined> {
  const result = await sql<RegisterShiftRow>`
    with locked as materialized (
      select shift.*
      from app.register_shifts shift
      where shift."businessId"=${businessId}::uuid and shift."storeId"=${storeId}::uuid
        and shift."id"=${shiftId}::uuid and shift."status"='open'
      for update
    ), totals as (
      select locked."id",
        coalesce(sum(case when movement."type" in ('cash_in','adjustment') then movement."amountMinor" else -movement."amountMinor" end),0)::bigint as movement_total
      from locked
      left join app.cash_movements movement on movement."shiftId"=locked."id"
      group by locked."id"
    )
    update app.register_shifts shift set
      "closedByMembershipId"=${membershipId}::uuid,
      "expectedCashMinor"=locked."openingCashMinor" + totals.movement_total,
      "countedCashMinor"=${countedCashMinor},
      "varianceMinor"=${countedCashMinor}::bigint - (locked."openingCashMinor" + totals.movement_total),
      "status"='closed', "closedAt"=now(), "notes"=${notes ?? null}
    from locked join totals on totals."id"=locked."id"
    where shift."id"=locked."id" returning shift.*
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listCashMovements(
  context: DatabaseContext,
  businessId: string,
  shiftId: string,
): Promise<CashMovementRow[]> {
  return (
    await sql<CashMovementRow>`select * from app.cash_movements where "businessId"=${businessId}::uuid and "shiftId"=${shiftId}::uuid order by "occurredAt", "id"`.execute(
      context.transaction,
    )
  ).rows;
}

export async function createCashMovement(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  shiftId: string,
  membershipId: string,
  requestId: string,
  input: CashMovementInput,
): Promise<CashMovementRow | undefined> {
  const result = await sql<CashMovementRow>`
    with locked_shift as materialized (
      select shift.* from app.register_shifts shift
      where shift."businessId"=${businessId}::uuid and shift."storeId"=${storeId}::uuid
        and shift."id"=${shiftId}::uuid and shift."status"='open'
      for update
    ), inserted as (
      insert into app.cash_movements ("businessId","storeId","locationId","registerId","shiftId","type","amountMinor","reason","actorMembershipId","requestId","idempotencyKey")
      select shift."businessId",shift."storeId",shift."locationId",shift."registerId",shift."id",${input.type},${input.amountMinor}::bigint,${input.reason},${membershipId}::uuid,${requestId},${input.idempotencyKey}
      from locked_shift shift
      on conflict ("businessId","idempotencyKey") do nothing
      returning *
    )
    select * from inserted
    union all
    select existing.* from app.cash_movements existing
    where existing."businessId"=${businessId}::uuid
      and existing."idempotencyKey"=${input.idempotencyKey}
      and not exists (select 1 from inserted)
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}
