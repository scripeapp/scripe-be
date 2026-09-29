import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { DeviceSessionRow, PosDeviceRow, ResolvedDevice, TillCustomerRow, TillOrderRow } from "./pos-devices.types.js";

const PAIRING_MINUTES = 15;

/**
 * Starts pairing a register: any earlier pending code for it stops working,
 * and a new pending device row holds only the hash of the new code.
 */
export async function createPairing(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  registerId: string,
  codeHash: string,
): Promise<{ expiresAt: Date } | undefined> {
  const register = (await sql<{ name: string }>`
    select "name" from app.registers
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "id" = ${registerId}::uuid and "status" = 'active'
    limit 1
  `.execute(context.transaction)).rows[0];
  if (!register) return undefined;
  await sql`
    update app.pos_devices set "status" = 'revoked', "pairingCodeHash" = null, "pairingCodeExpiresAt" = null, "revokedAt" = now()
    where "businessId" = ${businessId}::uuid and "registerId" = ${registerId}::uuid and "status" = 'pending'
  `.execute(context.transaction);
  const row = (await sql<{ pairingCodeExpiresAt: Date }>`
    insert into app.pos_devices ("businessId", "storeId", "registerId", "label", "pairingCodeHash", "pairingCodeExpiresAt")
    values (${businessId}::uuid, ${storeId}::uuid, ${registerId}::uuid, ${register.name}, ${codeHash},
            now() + ${`${PAIRING_MINUTES} minutes`}::interval)
    returning "pairingCodeExpiresAt"
  `.execute(context.transaction)).rows[0]!;
  return { expiresAt: row.pairingCodeExpiresAt };
}

export async function listDevices(context: DatabaseContext, businessId: string, registerId: string): Promise<PosDeviceRow[]> {
  return (await sql<PosDeviceRow>`
    select "id", "registerId", "label", "platform", "status", "pairedAt", "lastSeenAt", "revokedAt", "createdAt"
    from app.pos_devices
    where "businessId" = ${businessId}::uuid and "registerId" = ${registerId}::uuid and "status" in ('active', 'pending')
    order by "createdAt" desc
  `.execute(context.transaction)).rows;
}

/** Unpairs every device (and cancels any pending code) on a register. */
export async function revokeDevices(context: DatabaseContext, businessId: string, storeId: string, registerId: string): Promise<number> {
  const result = await sql<{ id: string }>`
    update app.pos_devices
       set "status" = 'revoked', "tokenHash" = null, "pairingCodeHash" = null, "pairingCodeExpiresAt" = null, "revokedAt" = now()
     where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "registerId" = ${registerId}::uuid
       and "status" in ('active', 'pending')
    returning "id"
  `.execute(context.transaction);
  return result.rows.length;
}

export async function pair(
  context: DatabaseContext,
  codeHash: string,
  tokenHash: string,
  label: string | null,
  platform: string | null,
): Promise<{ deviceId: string; businessId: string } | undefined> {
  return (await sql<{ deviceId: string; businessId: string }>`
    select "deviceId", "businessId" from app.pair_pos_device(${codeHash}, ${tokenHash}, ${label}, ${platform})
  `.execute(context.transaction)).rows[0];
}

export async function resolve(context: DatabaseContext, tokenHash: string): Promise<ResolvedDevice | undefined> {
  return (await sql<ResolvedDevice>`
    select "deviceId", "businessId", "storeId", "registerId", "locationId" from app.resolve_pos_device(${tokenHash})
  `.execute(context.transaction)).rows[0];
}

export async function session(context: DatabaseContext, device: ResolvedDevice): Promise<DeviceSessionRow | undefined> {
  return (await sql<DeviceSessionRow>`
    select register."id" as "registerId", register."name" as "registerName",
           location."id" as "locationId", location."name" as "locationName",
           store."id" as "storeId", store."name" as "storeName", store."slug" as "storeSlug"
    from app.registers register
    join app.locations location on location."id" = register."locationId"
    join app.stores store on store."id" = register."storeId"
    where register."id" = ${device.registerId}::uuid and register."businessId" = ${device.businessId}::uuid
    limit 1
  `.execute(context.transaction)).rows[0];
}

/** Customers a cashier can attach to a sale: people with a customer account, by name, email or phone. */
export async function customers(context: DatabaseContext, businessId: string, search: string | null, limit: number): Promise<TillCustomerRow[]> {
  const pattern = search ? `%${search}%` : null;
  return (await sql<TillCustomerRow>`
    select party."id", party."displayName" as "name",
      (select pc."value" from app.party_contacts pc where pc."partyId" = party."id" and pc."kind" = 'email' and pc."status" = 'active' order by pc."isPrimary" desc limit 1) as "email",
      (select pc."value" from app.party_contacts pc where pc."partyId" = party."id" and pc."kind" = 'phone' and pc."status" = 'active' order by pc."isPrimary" desc limit 1) as "phone"
    from app.parties party
    join app.customer_accounts account on account."partyId" = party."id" and account."businessId" = party."businessId"
    where party."businessId" = ${businessId}::uuid and party."status" = 'active'
      and (${pattern}::text is null or party."displayName" ilike ${pattern}
           or exists (select 1 from app.party_contacts pc where pc."partyId" = party."id" and pc."value" ilike ${pattern}))
    order by party."displayName"
    limit ${limit}
  `.execute(context.transaction)).rows;
}

/** Recent sales at this device's branch, newest first. */
export async function recentOrders(
  context: DatabaseContext,
  businessId: string,
  locationId: string,
  fulfilment: "open" | "fulfilled" | null,
  limit: number,
): Promise<TillOrderRow[]> {
  return (await sql<TillOrderRow>`
    select o."id", o."orderNumber", o."status", o."paymentStatus", o."fulfillmentStatus", o."totalMinor"::text as "totalMinor",
           o."currency", o."createdAt", party."displayName" as "customerName", staff."displayName" as "operatorName",
           (select count(*)::int from app.order_lines ol where ol."orderId" = o."id") as "lineCount"
    from app.orders o
    left join app.parties party on party."id" = o."customerPartyId"
    left join app.staff_profiles staff on staff."id" = o."operatorStaffId"
    where o."businessId" = ${businessId}::uuid and o."locationId" = ${locationId}::uuid
      and (${fulfilment}::text is null
           or (${fulfilment} = 'open' and o."fulfillmentStatus" <> 'fulfilled' and o."status" = 'placed')
           or (${fulfilment} = 'fulfilled' and o."fulfillmentStatus" = 'fulfilled'))
    order by o."createdAt" desc
    limit ${limit}
  `.execute(context.transaction)).rows;
}

export async function isCustomer(context: DatabaseContext, businessId: string, partyId: string): Promise<boolean> {
  return (await sql<{ id: string }>`
    select party."id" from app.parties party
    join app.customer_accounts account on account."partyId" = party."id" and account."businessId" = party."businessId"
    where party."businessId" = ${businessId}::uuid and party."id" = ${partyId}::uuid and party."status" = 'active'
    limit 1
  `.execute(context.transaction)).rows.length > 0;
}
