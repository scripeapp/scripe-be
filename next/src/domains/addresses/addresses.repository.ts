import type { DatabaseContext } from "../../db/database-context.js";
import type { CreateAddressInput, UpdateAddressInput, UserAddressRow } from "./addresses.types.js";

const COLUMNS = [
  "id", "userId", "label", "isDefault", "recipientName", "phone",
  "addressLine1", "addressLine2", "city", "state", "postalCode", "country",
  "createdAt", "updatedAt",
] as const;

export async function listForUser(context: DatabaseContext, userId: string): Promise<UserAddressRow[]> {
  return context.transaction
    .selectFrom("user_addresses")
    .select(COLUMNS)
    .where("userId", "=", userId)
    .orderBy("isDefault", "desc")
    .orderBy("createdAt", "asc")
    .execute();
}

export async function findForUser(context: DatabaseContext, userId: string, addressId: string): Promise<UserAddressRow | undefined> {
  return context.transaction
    .selectFrom("user_addresses")
    .select(COLUMNS)
    .where("userId", "=", userId)
    .where("id", "=", addressId)
    .executeTakeFirst();
}

/** Declarative one-default-per-user is enforced by a partial unique index, not a trigger — the caller must clear the prior default first. */
export async function clearDefaultForUser(context: DatabaseContext, userId: string): Promise<void> {
  await context.transaction
    .updateTable("user_addresses")
    .set({ isDefault: false })
    .where("userId", "=", userId)
    .where("isDefault", "=", true)
    .execute();
}

export async function createAddress(context: DatabaseContext, userId: string, input: CreateAddressInput): Promise<UserAddressRow> {
  if (input.isDefault) await clearDefaultForUser(context, userId);
  return context.transaction
    .insertInto("user_addresses")
    .values({
      userId,
      label: input.label ?? null,
      isDefault: input.isDefault ?? false,
      recipientName: input.recipientName,
      phone: input.phone,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2 ?? null,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode ?? null,
      ...(input.country !== undefined ? { country: input.country } : {}),
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
}

export async function updateAddress(context: DatabaseContext, userId: string, addressId: string, input: UpdateAddressInput): Promise<UserAddressRow | undefined> {
  if (input.isDefault) await clearDefaultForUser(context, userId);
  const values: Record<string, unknown> = {};
  if (input.label !== undefined) values.label = input.label;
  if (input.isDefault !== undefined) values.isDefault = input.isDefault;
  if (input.recipientName !== undefined) values.recipientName = input.recipientName;
  if (input.phone !== undefined) values.phone = input.phone;
  if (input.addressLine1 !== undefined) values.addressLine1 = input.addressLine1;
  if (input.addressLine2 !== undefined) values.addressLine2 = input.addressLine2;
  if (input.city !== undefined) values.city = input.city;
  if (input.state !== undefined) values.state = input.state;
  if (input.postalCode !== undefined) values.postalCode = input.postalCode;
  if (input.country !== undefined) values.country = input.country;
  if (Object.keys(values).length === 0) return findForUser(context, userId, addressId);

  return context.transaction
    .updateTable("user_addresses")
    .set(values)
    .where("userId", "=", userId)
    .where("id", "=", addressId)
    .returning(COLUMNS)
    .executeTakeFirst();
}

export interface DeletedAddress {
  readonly id: string;
  readonly wasDefault: boolean;
}

export async function deleteAddress(context: DatabaseContext, userId: string, addressId: string): Promise<DeletedAddress | undefined> {
  return context.transaction
    .deleteFrom("user_addresses")
    .where("userId", "=", userId)
    .where("id", "=", addressId)
    .returning(["id", "isDefault as wasDefault"])
    .executeTakeFirst();
}

/** Mirrors stores.repository.ts's promoteOldestStoreToDefault: if nothing is default, promote the oldest remaining address. */
export async function promoteOldestToDefaultIfNoneSet(context: DatabaseContext, userId: string): Promise<void> {
  const hasDefault = await context.transaction
    .selectFrom("user_addresses")
    .select("id")
    .where("userId", "=", userId)
    .where("isDefault", "=", true)
    .executeTakeFirst();
  if (hasDefault) return;

  const oldest = await context.transaction
    .selectFrom("user_addresses")
    .select("id")
    .where("userId", "=", userId)
    .orderBy("createdAt", "asc")
    .executeTakeFirst();
  if (!oldest) return;

  await context.transaction
    .updateTable("user_addresses")
    .set({ isDefault: true })
    .where("id", "=", oldest.id)
    .execute();
}
