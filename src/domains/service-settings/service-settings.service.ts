import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repository from "./service-settings.repository.js";
import type { UpsertServiceSettingsInput } from "./service-settings.schemas.js";
import type { ServiceSettings, ServiceSettingsOperation, ServiceSettingsRow } from "./service-settings.types.js";

const SERVICE_PRODUCT_TYPE = "service";

export class ServiceSettingsService {
  constructor(private readonly database: Database) {}

  async get(operation: ServiceSettingsOperation, productId: string): Promise<ServiceSettings> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, "product.read");
      const settings = await repository.findSettings(context, operation.businessId, productId);
      if (!settings) throw notFoundError("Service settings have not been set for this product");
      return toServiceSettings(settings);
    });
  }

  async upsert(
    operation: ServiceSettingsOperation,
    productId: string,
    input: UpsertServiceSettingsInput,
  ): Promise<ServiceSettings> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, "product.update");
      const productType = await repository.findProductType(context, operation.businessId, productId);
      if (!productType) throw notFoundError("Product not found");
      if (productType !== SERVICE_PRODUCT_TYPE) {
        throw validationError("Booking settings apply only to service products");
      }
      const saved = await repository.upsertSettings(context, operation.businessId, productId, input);
      return toServiceSettings(saved);
    });
  }

  private async run<T>(
    operation: ServiceSettingsOperation,
    work: Parameters<typeof withDatabaseContext<T>>[2],
  ): Promise<T> {
    try {
      return await withDatabaseContext(
        this.database,
        withIdentity(operation.requestId, operation.userId, operation.businessId),
        work,
      );
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toServiceSettings(row: ServiceSettingsRow): ServiceSettings {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
