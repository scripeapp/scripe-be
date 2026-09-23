import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import {
  AppError,
  conflictError,
  notFoundError,
} from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import { listPublicCategories, listPublicProducts, listPublicProductsByIds } from "../products/products.service.js";
import type { Category, PublicProduct } from "../products/products.types.js";
import * as repository from "./stores.repository.js";
import type {
  CashMovementRow,
  CashMovementInput,
  ChannelInput,
  Location,
  LocationInput,
  LocationRow,
  OperationContext,
  PublicStore,
  RegisterInput,
  RegisterRow,
  RegisterShiftRow,
  SalesChannelRow,
  Store,
  StoreCreateInput,
  StoreRow,
  StoreUpdateInput,
} from "./stores.types.js";

export class StoresService {
  constructor(private readonly database: Database) {}

  async listStores(operation: OperationContext): Promise<Store[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      return (await repository.listStores(context, operation.businessId)).map(
        toStore,
      );
    });
  }

  /**
   * Public storefront browsing surface — no requireAuth, no business
   * permission check. RLS's *_public_read policies (migration 0046) are
   * the actual enforcement; this only ever sees "active" rows regardless
   * of what this code does or doesn't check. Scope: browsing only — cart,
   * checkout, payment, and order lookup are a separate, later pass.
   */
  async getPublicStore(requestId: string, slug: string): Promise<PublicStore> {
    return this.runAnonymous(requestId, async (context) => {
      const store = await repository.findActiveStoreBySlug(context, slug);
      if (!store) throw notFoundError("Store not found");
      return toPublicStore(store);
    });
  }

  async listPublicProducts(requestId: string, slug: string): Promise<PublicProduct[]> {
    return this.runAnonymous(requestId, async (context) => {
      const store = await repository.findActiveStoreBySlug(context, slug);
      if (!store) throw notFoundError("Store not found");
      return listPublicProducts(context, store.businessId, store.id);
    });
  }

  async listPublicCategories(requestId: string, slug: string): Promise<Category[]> {
    return this.runAnonymous(requestId, async (context) => {
      const store = await repository.findActiveStoreBySlug(context, slug);
      if (!store) throw notFoundError("Store not found");
      return listPublicCategories(context, store.businessId);
    });
  }

  /** For order-confirmation display — not scoped to a single store's slug. */
  async listPublicProductsByIds(requestId: string, ids: readonly string[]): Promise<PublicProduct[]> {
    return this.runAnonymous(requestId, (context) => listPublicProductsByIds(context, ids));
  }

  async getStore(operation: OperationContext, storeId: string): Promise<Store> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      return toStore(
        await this.requireStore(context, operation.businessId, storeId),
      );
    });
  }

  async createStore(
    operation: OperationContext,
    input: StoreCreateInput,
  ): Promise<Store> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.create");
      await repository.lockBusiness(context, operation.businessId);
      const stores = await repository.listStores(context, operation.businessId);
      const isDefault = stores.length === 0 || input.isDefault;
      if (isDefault)
        await repository.clearDefaultStore(context, operation.businessId);
      return toStore(
        await repository.createStore(
          context,
          operation.businessId,
          operation.userId,
          input,
          isDefault,
        ),
      );
    });
  }

  async updateStore(
    operation: OperationContext,
    storeId: string,
    input: StoreUpdateInput,
  ): Promise<Store> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.update");
      await repository.lockBusiness(context, operation.businessId);
      const current = await this.requireStore(
        context,
        operation.businessId,
        storeId,
      );
      if (current.isDefault && input.isDefault === false) {
        throw conflictError("Choose another default store before unsetting this one");
      }
      if (input.isDefault)
        await repository.clearDefaultStore(
          context,
          operation.businessId,
          storeId,
        );
      const store = await repository.updateStore(
        context,
        operation.businessId,
        storeId,
        input,
      );
      if (!store) throw notFoundError("Store not found");
      return toStore(store);
    });
  }

  async archiveStore(
    operation: OperationContext,
    storeId: string,
  ): Promise<Store> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.archive");
      await repository.lockBusiness(context, operation.businessId);
      const stores = await repository.listStores(context, operation.businessId);
      if (stores.length <= 1)
        throw conflictError("A business must retain at least one store");
      const target = stores.find((store) => store.id === storeId);
      if (!target) throw notFoundError("Store not found");
      const archived = await repository.archiveStore(
        context,
        operation.businessId,
        storeId,
      );
      if (!archived) throw notFoundError("Store not found");
      if (target.isDefault)
        await repository.promoteOldestStoreToDefault(
          context,
          operation.businessId,
        );
      return toStore(archived);
    });
  }

  async listLocations(
    operation: OperationContext,
    storeId: string,
  ): Promise<Location[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      await this.requireStore(context, operation.businessId, storeId);
      return (
        await repository.listLocations(context, operation.businessId, storeId)
      ).map(toLocation);
    });
  }

  async createLocation(
    operation: OperationContext,
    storeId: string,
    input: LocationInput,
  ): Promise<Location> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "location.manage");
      if (!(await repository.lockStore(context, operation.businessId, storeId)))
        throw notFoundError("Store not found");
      const locations = await repository.listLocations(
        context,
        operation.businessId,
        storeId,
      );
      const isDefault = locations.length === 0 || input.isDefault;
      if (isDefault) await repository.clearDefaultLocation(context, storeId);
      return toLocation(
        await repository.createLocation(
          context,
          operation.businessId,
          storeId,
          input,
          isDefault,
        ),
      );
    });
  }

  async updateLocation(
    operation: OperationContext,
    storeId: string,
    locationId: string,
    input: Partial<LocationInput>,
  ): Promise<Location> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "location.manage");
      if (!(await repository.lockStore(context, operation.businessId, storeId)))
        throw notFoundError("Store not found");
      if (input.isDefault)
        await repository.clearDefaultLocation(context, storeId, locationId);
      const location = await repository.updateLocation(
        context,
        operation.businessId,
        storeId,
        locationId,
        input,
      );
      if (!location) throw notFoundError("Location not found");
      return toLocation(location);
    });
  }

  async archiveLocation(
    operation: OperationContext,
    storeId: string,
    locationId: string,
  ): Promise<Location> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "location.manage");
      if (!(await repository.lockStore(context, operation.businessId, storeId)))
        throw notFoundError("Store not found");
      const locations = await repository.listLocations(
        context,
        operation.businessId,
        storeId,
      );
      const target = locations.find((location) => location.id === locationId);
      if (!target) throw notFoundError("Location not found");
      const location = await repository.archiveLocation(
        context,
        operation.businessId,
        storeId,
        locationId,
      );
      if (!location) throw notFoundError("Location not found");
      if (target.isDefault) {
        const next = locations.find((candidate) => candidate.id !== locationId);
        if (next)
          await repository.updateLocation(
            context,
            operation.businessId,
            storeId,
            next.id,
            { isDefault: true },
          );
      }
      return toLocation(location);
    });
  }

  async listChannels(
    operation: OperationContext,
    storeId: string,
  ): Promise<ReturnType<typeof toChannel>[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      await this.requireStore(context, operation.businessId, storeId);
      return (
        await repository.listChannels(context, operation.businessId, storeId)
      ).map(toChannel);
    });
  }

  async createChannel(
    operation: OperationContext,
    storeId: string,
    input: ChannelInput,
  ): Promise<ReturnType<typeof toChannel>> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "channel.manage");
      await this.requireStore(context, operation.businessId, storeId);
      return toChannel(
        await repository.createChannel(
          context,
          operation.businessId,
          storeId,
          input,
        ),
      );
    });
  }

  async updateChannel(
    operation: OperationContext,
    storeId: string,
    channelId: string,
    input: Partial<ChannelInput>,
  ): Promise<ReturnType<typeof toChannel>> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "channel.manage");
      const row = await repository.updateChannel(
        context,
        operation.businessId,
        storeId,
        channelId,
        input,
      );
      if (!row) throw notFoundError("Sales channel not found");
      return toChannel(row);
    });
  }

  async archiveChannel(
    operation: OperationContext,
    storeId: string,
    channelId: string,
  ): Promise<ReturnType<typeof toChannel>> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "channel.manage");
      const row = await repository.archiveChannel(
        context,
        operation.businessId,
        storeId,
        channelId,
      );
      if (!row) throw notFoundError("Sales channel not found");
      return toChannel(row);
    });
  }

  async listRegisters(
    operation: OperationContext,
    storeId: string,
  ): Promise<ReturnType<typeof toRegister>[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      await this.requireStore(context, operation.businessId, storeId);
      return (
        await repository.listRegisters(context, operation.businessId, storeId)
      ).map(toRegister);
    });
  }

  async createRegister(
    operation: OperationContext,
    storeId: string,
    input: RegisterInput,
  ): Promise<ReturnType<typeof toRegister>> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "register.manage");
      return toRegister(
        await repository.createRegister(
          context,
          operation.businessId,
          storeId,
          input,
        ),
      );
    });
  }

  async updateRegister(
    operation: OperationContext,
    storeId: string,
    registerId: string,
    input: Partial<RegisterInput>,
  ): Promise<ReturnType<typeof toRegister>> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "register.manage");
      const row = await repository.updateRegister(
        context,
        operation.businessId,
        storeId,
        registerId,
        input,
      );
      if (!row) throw notFoundError("Register not found");
      return toRegister(row);
    });
  }

  async archiveRegister(
    operation: OperationContext,
    storeId: string,
    registerId: string,
  ): Promise<ReturnType<typeof toRegister>> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "register.manage");
      const row = await repository.archiveRegister(
        context,
        operation.businessId,
        storeId,
        registerId,
      );
      if (!row)
        throw conflictError(
          "Register was not found or still has an open shift",
        );
      return toRegister(row);
    });
  }

  async getCurrentShift(
    operation: OperationContext,
    registerId: string,
  ): Promise<ReturnType<typeof toShift> | null> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      const shift = await repository.findOpenShift(
        context,
        operation.businessId,
        registerId,
      );
      return shift ? toShift(shift) : null;
    });
  }

  async openShift(
    operation: OperationContext,
    storeId: string,
    registerId: string,
    openingCashMinor: string,
  ): Promise<ReturnType<typeof toShift>> {
    return this.run(operation, async (context) => {
      const membershipId = await this.authorize(
        context,
        operation.businessId,
        "register.operate",
      );
      const row = await repository.openShift(
        context,
        operation.businessId,
        storeId,
        registerId,
        membershipId,
        openingCashMinor,
      );
      if (!row) throw notFoundError("Active register not found");
      return toShift(row);
    });
  }

  async closeShift(
    operation: OperationContext,
    storeId: string,
    shiftId: string,
    countedCashMinor: string,
    notes?: string,
  ): Promise<ReturnType<typeof toShift>> {
    return this.run(operation, async (context) => {
      const membershipId = await this.authorize(
        context,
        operation.businessId,
        "register.operate",
      );
      const row = await repository.closeShift(
        context,
        operation.businessId,
        storeId,
        shiftId,
        membershipId,
        countedCashMinor,
        notes,
      );
      if (!row) throw conflictError("Open register shift not found");
      return toShift(row);
    });
  }

  async listCashMovements(
    operation: OperationContext,
    shiftId: string,
  ): Promise<ReturnType<typeof toCashMovement>[]> {
    return this.run(operation, async (context) => {
      await this.authorize(context, operation.businessId, "store.read");
      return (
        await repository.listCashMovements(
          context,
          operation.businessId,
          shiftId,
        )
      ).map(toCashMovement);
    });
  }

  async createCashMovement(
    operation: OperationContext,
    storeId: string,
    shiftId: string,
    input: CashMovementInput,
  ): Promise<ReturnType<typeof toCashMovement>> {
    return this.run(operation, async (context) => {
      const membershipId = await this.authorize(
        context,
        operation.businessId,
        "cash.manage",
      );
      const row = await repository.createCashMovement(
        context,
        operation.businessId,
        storeId,
        shiftId,
        membershipId,
        operation.requestId,
        input,
      );
      if (!row) throw conflictError("Cash movements require an open shift");
      if (
        row.shiftId !== shiftId ||
        row.type !== input.type ||
        row.amountMinor !== input.amountMinor ||
        row.reason !== input.reason
      ) {
        throw conflictError("Idempotency key was already used for a different cash movement");
      }
      return toCashMovement(row);
    });
  }

  private async authorize(
    context: Parameters<typeof repository.findStore>[0],
    businessId: string,
    permission: string,
  ): Promise<string> {
    return authorization.requireAuthorizedMembership(context, businessId, permission);
  }

  private async requireStore(
    context: Parameters<typeof repository.findStore>[0],
    businessId: string,
    storeId: string,
  ): Promise<StoreRow> {
    const store = await repository.findStore(context, businessId, storeId);
    if (!store || store.status === "archived")
      throw notFoundError("Store not found");
    return store;
  }

  private async runAnonymous<T>(
    requestId: string,
    work: Parameters<typeof withDatabaseContext<T>>[2],
  ): Promise<T> {
    try {
      return await withDatabaseContext(this.database, anonymousPrincipal(requestId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError)
        throw error;
      throw normalizeDatabaseError(error);
    }
  }

  private async run<T>(
    operation: OperationContext,
    work: Parameters<typeof withDatabaseContext<T>>[2],
  ): Promise<T> {
    try {
      return await withDatabaseContext(
        this.database,
        withIdentity(
          operation.requestId,
          operation.userId,
          operation.businessId,
        ),
        work,
      );
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError)
        throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toPublicStore(row: StoreRow): PublicStore {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    sellsOnline: row.sellsOnline,
    sellsInPerson: row.sellsInPerson,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
  };
}

function toStore(row: StoreRow): Store {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toLocation(row: LocationRow): Location {
  const hours =
    row.businessHours &&
    typeof row.businessHours === "object" &&
    !Array.isArray(row.businessHours)
      ? (row.businessHours as Record<string, unknown>)
      : {};
  const serviceChargeRates =
    row.serviceChargeRates &&
    typeof row.serviceChargeRates === "object" &&
    !Array.isArray(row.serviceChargeRates)
      ? (row.serviceChargeRates as Location["serviceChargeRates"])
      : {};
  return {
    ...row,
    businessHours: hours,
    serviceChargeRates,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toChannel(row: SalesChannelRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRegister(row: RegisterRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toShift(row: RegisterShiftRow) {
  return {
    ...row,
    openingCashMinor: row.openingCashMinor,
    expectedCashMinor: row.expectedCashMinor,
    countedCashMinor: row.countedCashMinor,
    varianceMinor: row.varianceMinor,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCashMovement(row: CashMovementRow) {
  return {
    ...row,
    amountMinor: row.amountMinor,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
