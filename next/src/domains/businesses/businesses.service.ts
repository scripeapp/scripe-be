import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repository from "./businesses.repository.js";
import type { Business, BusinessCreateInput, BusinessListRow, BusinessOperation, BusinessUpdateInput } from "./businesses.types.js";

export class BusinessesService {
  constructor(private readonly database: Database) {}

  async list(operation: BusinessOperation): Promise<Business[]> {
    return this.run(operation, null, async (context) =>
      (await repository.listBusinesses(context)).map(toBusiness),
    );
  }

  async get(operation: BusinessOperation, businessId: string): Promise<Business> {
    return this.run(operation, businessId, async (context) => {
      const row = await repository.findBusiness(context, businessId);
      if (!row) throw notFoundError("Business not found");
      return toBusiness(row);
    });
  }

  async create(operation: BusinessOperation, input: BusinessCreateInput): Promise<Business> {
    return this.run(operation, null, async (context) => {
      const storeSlug = `${slugify(input.displayName)}-${randomUUID().slice(0, 8)}`;
      const created = await repository.createBusiness(context, input, storeSlug);
      await repository.setBusinessContext(context, created.id);
      const row = await repository.findBusiness(context, created.id);
      if (!row) throw new Error("Created business could not be read in its transaction");
      return toBusiness(row);
    });
  }

  async update(operation: BusinessOperation, businessId: string, input: BusinessUpdateInput): Promise<Business> {
    return this.run(operation, businessId, async (context) => {
      await this.requirePermission(context, businessId, "business.update");
      const updated = await repository.updateBusiness(context, businessId, input);
      if (!updated) throw notFoundError("Business not found");
      const row = await repository.findBusiness(context, businessId);
      if (!row) throw notFoundError("Business not found");
      return toBusiness(row);
    });
  }

  async archive(operation: BusinessOperation, businessId: string): Promise<void> {
    return this.run(operation, businessId, async (context) => {
      await this.requirePermission(context, businessId, "business.archive");
      const archived = await repository.archiveBusiness(context, businessId);
      if (!archived) throw notFoundError("Business not found");
    });
  }

  private async requirePermission(context: Parameters<typeof repository.findBusiness>[0], businessId: string, permission: string): Promise<void> {
    return authorization.requirePermission(context, businessId, permission);
  }

  private async run<T>(operation: BusinessOperation, businessId: string | null, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "store";
}

function toBusiness(row: BusinessListRow): Business {
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status,
    defaultCurrency: row.defaultCurrency,
    timezone: row.timezone,
    primaryVertical: row.primaryVertical,
    createdBy: row.createdBy,
    roleCodes: row.roleCodes,
    defaultStore: { id: row.defaultStoreId, name: row.defaultStoreName, slug: row.defaultStoreSlug },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
