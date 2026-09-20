import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  AddressKind,
  ContactKind,
  CreateAddressInput,
  CreateContactInput,
  CreatePartyInput,
  CustomerAccountInput,
  CustomerAccountRow,
  PartyAddressRow,
  PartyContactRow,
  PartyRow,
  PartyStatus,
  SupplierAccountInput,
  SupplierAccountRow,
  UpdateAddressInput,
  UpdateContactInput,
  UpdatePartyInput,
} from "./parties.types.js";

export async function authorizedMembership(context: DatabaseContext, businessId: string, permission: string): Promise<string | undefined> {
  const result = await sql<{ membershipId: string }>`
    select membership."id" as "membershipId"
    from app.business_memberships membership
    where membership."businessId" = ${businessId}::uuid
      and membership."userId"::text = app.current_user_id()
      and membership."status" = 'active'
      and app.has_business_permission(${businessId}::uuid, ${permission})
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.membershipId;
}

export async function listParties(context: DatabaseContext, businessId: string, options: { role?: "customer" | "supplier"; status?: PartyStatus; search?: string; limit: number; cursor?: string }): Promise<PartyRow[]> {
  const roleFilter = options.role === "customer"
    ? sql`and exists (select 1 from app.customer_accounts account where account."businessId" = party."businessId" and account."partyId" = party."id")`
    : options.role === "supplier"
      ? sql`and exists (select 1 from app.supplier_accounts account where account."businessId" = party."businessId" and account."partyId" = party."id")`
      : sql``;
  const statusFilter = options.status ? sql`and party."status" = ${options.status}` : sql`and party."status" <> 'archived'`;
  const searchFilter = options.search ? sql`and lower(party."displayName") like ${`%${options.search.toLowerCase()}%`}` : sql``;
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const cursorFilter = cursor ? sql`and (party."createdAt", party."id") < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``;
  const result = await sql<PartyRow>`
    select party.* from app.parties party
    where party."businessId" = ${businessId}::uuid ${statusFilter} ${roleFilter} ${searchFilter} ${cursorFilter}
    order by party."createdAt" desc, party."id" desc
    limit ${options.limit}
  `.execute(context.transaction);
  return result.rows;
}

export async function findParty(context: DatabaseContext, businessId: string, partyId: string): Promise<PartyRow | undefined> {
  const result = await sql<PartyRow>`select * from app.parties where "businessId"=${businessId}::uuid and "id"=${partyId}::uuid limit 1`.execute(context.transaction);
  return result.rows[0];
}

export async function createParty(context: DatabaseContext, businessId: string, userId: string, input: CreatePartyInput): Promise<PartyRow> {
  const result = await sql<PartyRow>`
    insert into app.parties ("businessId", "kind", "displayName", "legalName", "createdBy")
    values (${businessId}::uuid, ${input.kind}, ${input.displayName}, ${input.legalName ?? null}, ${userId}::uuid)
    returning *
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateParty(context: DatabaseContext, businessId: string, partyId: string, input: UpdatePartyInput): Promise<PartyRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.kind !== undefined) fields.push(sql`"kind"=${input.kind}`);
  if (input.displayName !== undefined) fields.push(sql`"displayName"=${input.displayName}`);
  if (input.legalName !== undefined) fields.push(sql`"legalName"=${input.legalName}`);
  if (input.status !== undefined) fields.push(sql`"status"=${input.status}`);
  return (await sql<PartyRow>`update app.parties set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "id"=${partyId}::uuid and "status" <> 'archived' returning *`.execute(context.transaction)).rows[0];
}

export async function archiveParty(context: DatabaseContext, businessId: string, partyId: string): Promise<PartyRow | undefined> {
  return (await sql<PartyRow>`update app.parties set "status"='archived', "archivedAt"=now() where "businessId"=${businessId}::uuid and "id"=${partyId}::uuid and "status" <> 'archived' returning *`.execute(context.transaction)).rows[0];
}

export async function listContacts(context: DatabaseContext, businessId: string, partyId: string): Promise<PartyContactRow[]> {
  return (await sql<PartyContactRow>`select * from app.party_contacts where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "status"='active' order by "isPrimary" desc, "kind", "createdAt"`.execute(context.transaction)).rows;
}

export async function createContact(context: DatabaseContext, businessId: string, partyId: string, input: CreateContactInput): Promise<PartyContactRow> {
  if (input.isPrimary) await clearPrimaryContact(context, businessId, partyId, input.kind);
  const normalizedValue = normalizeContact(input.kind, input.value);
  return (await sql<PartyContactRow>`insert into app.party_contacts ("businessId","partyId","kind","value","normalizedValue","label","isPrimary") values (${businessId}::uuid,${partyId}::uuid,${input.kind},${input.value},${normalizedValue},${input.label ?? null},${input.isPrimary}) returning *`.execute(context.transaction)).rows[0]!;
}

export async function updateContact(context: DatabaseContext, businessId: string, partyId: string, contactId: string, input: UpdateContactInput): Promise<PartyContactRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  const current = (input.value !== undefined || input.isPrimary !== undefined)
    ? (await sql<{ kind: ContactKind }>`select "kind" from app.party_contacts where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "id"=${contactId}::uuid`.execute(context.transaction)).rows[0]
    : undefined;
  if (input.value !== undefined) {
    fields.push(sql`"value"=${input.value}`);
    fields.push(sql`"normalizedValue"=${normalizeContact(current?.kind ?? "email", input.value)}`);
  }
  if (input.label !== undefined) fields.push(sql`"label"=${input.label}`);
  if (input.isPrimary !== undefined) {
    if (current && input.isPrimary) await clearPrimaryContact(context, businessId, partyId, current.kind);
    fields.push(sql`"isPrimary"=${input.isPrimary}`);
  }
  return (await sql<PartyContactRow>`update app.party_contacts set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "id"=${contactId}::uuid and "status"='active' returning *`.execute(context.transaction)).rows[0];
}

export async function archiveContact(context: DatabaseContext, businessId: string, partyId: string, contactId: string): Promise<PartyContactRow | undefined> {
  return (await sql<PartyContactRow>`update app.party_contacts set "status"='archived', "isPrimary"=false where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "id"=${contactId}::uuid and "status"='active' returning *`.execute(context.transaction)).rows[0];
}

async function clearPrimaryContact(context: DatabaseContext, businessId: string, partyId: string, kind: ContactKind): Promise<void> {
  await sql`update app.party_contacts set "isPrimary"=false where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "kind"=${kind} and "status"='active'`.execute(context.transaction);
}

export async function listAddresses(context: DatabaseContext, businessId: string, partyId: string): Promise<PartyAddressRow[]> {
  return (await sql<PartyAddressRow>`select * from app.party_addresses where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "status"='active' order by "isDefault" desc, "kind", "createdAt"`.execute(context.transaction)).rows;
}

export async function createAddress(context: DatabaseContext, businessId: string, partyId: string, input: CreateAddressInput): Promise<PartyAddressRow> {
  if (input.isDefault) await clearDefaultAddress(context, businessId, partyId, input.kind);
  return (await sql<PartyAddressRow>`insert into app.party_addresses ("businessId","partyId","kind","label","line1","line2","city","state","postalCode","countryCode","isDefault") values (${businessId}::uuid,${partyId}::uuid,${input.kind},${input.label ?? null},${input.line1},${input.line2 ?? null},${input.city ?? null},${input.state ?? null},${input.postalCode ?? null},${input.countryCode ?? 'NG'},${input.isDefault}) returning *`.execute(context.transaction)).rows[0]!;
}

export async function updateAddress(context: DatabaseContext, businessId: string, partyId: string, addressId: string, input: UpdateAddressInput): Promise<PartyAddressRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.kind !== undefined) fields.push(sql`"kind"=${input.kind}`);
  if (input.label !== undefined) fields.push(sql`"label"=${input.label}`);
  if (input.line1 !== undefined) fields.push(sql`"line1"=${input.line1}`);
  if (input.line2 !== undefined) fields.push(sql`"line2"=${input.line2}`);
  if (input.city !== undefined) fields.push(sql`"city"=${input.city}`);
  if (input.state !== undefined) fields.push(sql`"state"=${input.state}`);
  if (input.postalCode !== undefined) fields.push(sql`"postalCode"=${input.postalCode}`);
  if (input.countryCode !== undefined) fields.push(sql`"countryCode"=${input.countryCode}`);
  if (input.isDefault !== undefined) {
    if (input.isDefault) {
      const current = (await sql<{ kind: AddressKind }>`select "kind" from app.party_addresses where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "id"=${addressId}::uuid`.execute(context.transaction)).rows[0];
      if (current) await clearDefaultAddress(context, businessId, partyId, current.kind);
    }
    fields.push(sql`"isDefault"=${input.isDefault}`);
  }
  return (await sql<PartyAddressRow>`update app.party_addresses set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "id"=${addressId}::uuid and "status"='active' returning *`.execute(context.transaction)).rows[0];
}

export async function archiveAddress(context: DatabaseContext, businessId: string, partyId: string, addressId: string): Promise<PartyAddressRow | undefined> {
  return (await sql<PartyAddressRow>`update app.party_addresses set "status"='archived', "isDefault"=false where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "id"=${addressId}::uuid and "status"='active' returning *`.execute(context.transaction)).rows[0];
}

async function clearDefaultAddress(context: DatabaseContext, businessId: string, partyId: string, kind: AddressKind): Promise<void> {
  await sql`update app.party_addresses set "isDefault"=false where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid and "kind"=${kind} and "status"='active'`.execute(context.transaction);
}

export async function findCustomer(context: DatabaseContext, businessId: string, partyId: string): Promise<CustomerAccountRow | undefined> {
  return (await sql<CustomerAccountRow>`select * from app.customer_accounts where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid`.execute(context.transaction)).rows[0];
}
export async function createCustomer(context: DatabaseContext, businessId: string, partyId: string, input: CustomerAccountInput): Promise<CustomerAccountRow> {
  return (await sql<CustomerAccountRow>`insert into app.customer_accounts ("businessId","partyId","acquisitionChannel","lifecycleState") values (${businessId}::uuid,${partyId}::uuid,${input.acquisitionChannel ?? null},${input.lifecycleState ?? 'active'}) returning *`.execute(context.transaction)).rows[0]!;
}
export async function updateCustomer(context: DatabaseContext, businessId: string, partyId: string, input: CustomerAccountInput): Promise<CustomerAccountRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.acquisitionChannel !== undefined) fields.push(sql`"acquisitionChannel"=${input.acquisitionChannel}`);
  if (input.lifecycleState !== undefined) fields.push(sql`"lifecycleState"=${input.lifecycleState}`);
  return (await sql<CustomerAccountRow>`update app.customer_accounts set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid returning *`.execute(context.transaction)).rows[0];
}
export async function findSupplier(context: DatabaseContext, businessId: string, partyId: string): Promise<SupplierAccountRow | undefined> {
  return (await sql<SupplierAccountRow>`select * from app.supplier_accounts where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid`.execute(context.transaction)).rows[0];
}
export async function createSupplier(context: DatabaseContext, businessId: string, partyId: string, input: SupplierAccountInput): Promise<SupplierAccountRow> {
  return (await sql<SupplierAccountRow>`insert into app.supplier_accounts ("businessId","partyId","code","paymentTerms","taxId","status") values (${businessId}::uuid,${partyId}::uuid,${input.code ?? null},${input.paymentTerms ?? 'Net 30'},${input.taxId ?? null},${input.status ?? 'active'}) returning *`.execute(context.transaction)).rows[0]!;
}
export async function updateSupplier(context: DatabaseContext, businessId: string, partyId: string, input: SupplierAccountInput): Promise<SupplierAccountRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.code !== undefined) fields.push(sql`"code"=${input.code}`);
  if (input.paymentTerms !== undefined) fields.push(sql`"paymentTerms"=${input.paymentTerms}`);
  if (input.taxId !== undefined) fields.push(sql`"taxId"=${input.taxId}`);
  if (input.status !== undefined) fields.push(sql`"status"=${input.status}`);
  return (await sql<SupplierAccountRow>`update app.supplier_accounts set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "partyId"=${partyId}::uuid returning *`.execute(context.transaction)).rows[0];
}

function normalizeContact(kind: ContactKind, value: string): string {
  return kind === "email" ? value.trim().toLowerCase() : value.replace(/[^\d+]/g, "");
}

export function encodeCursor(row: PartyRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }), "utf8").toString("base64url");
}
function decodeCursor(value: string): { createdAt: string; id: string } {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { createdAt?: unknown }).createdAt !== "string" || typeof (parsed as { id?: unknown }).id !== "string") throw new Error("Invalid cursor");
  return parsed as { createdAt: string; id: string };
}
