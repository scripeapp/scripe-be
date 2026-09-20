import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import * as repository from "./addresses.repository.js";
import type { AddressesOperation, CreateAddressInput, UpdateAddressInput, UserAddress, UserAddressRow } from "./addresses.types.js";

export class AddressesService {
  constructor(private readonly database: Database) {}

  async list(operation: AddressesOperation): Promise<UserAddress[]> {
    return this.run(operation, async (context) => (await repository.listForUser(context, operation.userId)).map(toUserAddress));
  }

  async create(operation: AddressesOperation, input: CreateAddressInput): Promise<UserAddress> {
    return this.run(operation, async (context) => toUserAddress(await repository.createAddress(context, operation.userId, input)));
  }

  async update(operation: AddressesOperation, addressId: string, input: UpdateAddressInput): Promise<UserAddress> {
    return this.run(operation, async (context) => {
      const updated = await repository.updateAddress(context, operation.userId, addressId, input);
      if (!updated) throw notFoundError("Address not found");
      return toUserAddress(updated);
    });
  }

  async remove(operation: AddressesOperation, addressId: string): Promise<void> {
    return this.run(operation, async (context) => {
      const deleted = await repository.deleteAddress(context, operation.userId, addressId);
      if (!deleted) throw notFoundError("Address not found");
      if (deleted.wasDefault) await repository.promoteOldestToDefaultIfNoneSet(context, operation.userId);
    });
  }

  private async run<T>(operation: AddressesOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toUserAddress(row: UserAddressRow): UserAddress {
  return {
    id: row.id,
    label: row.label,
    isDefault: row.isDefault,
    recipientName: row.recipientName,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
