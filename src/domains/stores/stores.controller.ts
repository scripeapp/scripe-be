import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { notFoundError, validationError } from "../../shared/errors.js";
import * as schemas from "./stores.schemas.js";
import type { StoresService } from "./stores.service.js";
import type { OperationContext } from "./stores.types.js";

export class StoresController {
  constructor(private readonly service: StoresService) {}

  // Public storefront browsing — no requireAuthContext, request.requestId only.
  readonly getPublicStore = this.handle(async (request) => {
    const { slug } = schemas.publicStoreParamsSchema.parse(request.params);
    const store = await this.service.getPublicStore(request.requestId, slug);
    return { store, data: store, ...(typeof store === "object" ? store : {}) };
  });

  readonly listPublicProducts = this.handle(async (request) => {
    const { slug } = schemas.publicStoreParamsSchema.parse(request.params);
    return { products: await this.service.listPublicProducts(request.requestId, slug) };
  });

  readonly listPublicCategories = this.handle(async (request) => {
    const { slug } = schemas.publicStoreParamsSchema.parse(request.params);
    return { categories: await this.service.listPublicCategories(request.requestId, slug) };
  });

  readonly listPublicProductsByIds = this.handle(async (request) => {
    const ids = schemas.publicProductIdsQuerySchema.parse(request.query);
    return { products: await this.service.listPublicProductsByIds(request.requestId, ids) };
  });

  readonly getPublicProduct = this.handle(async (request) => {
    const { slug } = schemas.publicStoreParamsSchema.parse(request.params);
    const productIdOrSlug = request.params.productIdOrSlug || request.params.productId || request.params.productSlug;
    if (!productIdOrSlug) throw validationError("Missing product identifier");
    const { store, product } = await this.service.getPublicProduct(request.requestId, slug, productIdOrSlug);
    return { store, product, data: { store, product } };
  });

  readonly listPublicBranches = this.handle(async (request) => {
    const { slug } = schemas.publicStoreParamsSchema.parse(request.params);
    return await this.service.listPublicBranches(request.requestId, slug);
  });

  readonly listPublicDeliveryMethods = this.handle(async () => {
    return { delivery_methods: [], data: [] };
  });

  readonly getPublicManifest = this.handle(async (request) => {
    const { slug } = schemas.publicStoreParamsSchema.parse(request.params);
    const store = await this.service.getPublicStore(request.requestId, slug);
    return {
      name: store.name,
      short_name: store.name,
      start_url: `/s/${slug}`,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#000000",
    };
  });

  readonly getPublicOrderByReference = this.handle(async (request) => {
    const reference = request.params.reference;
    if (!reference) throw validationError("Missing reference");
    const order = await this.service.getPublicOrderByReference(request.requestId, reference);
    return { order, data: order, ...(typeof order === "object" ? order : {}) };
  });

  readonly listStores = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      stores: await this.service.listStores(
        this.operation(request, businessId),
      ),
    };
  }, 200, schemas.storesResultSchema);

  readonly createStore = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      store: await this.service.createStore(
        this.operation(request, businessId),
        schemas.createStoreSchema.parse(request.body),
      ),
    };
  }, 201, schemas.storeResultSchema);

  readonly getStore = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      store: await this.service.getStore(
        this.operation(request, businessId),
        storeId,
      ),
    };
  }, 200, schemas.storeResultSchema);

  readonly getStoreDirect = this.handle(async (request) => {
    const storeIdParam = request.params.storeId;
    const businessId =
      (request.query.business_id as string) ||
      (request.query.businessId as string) ||
      (request.headers["x-business-id"] as string);

    if (!businessId) {
      throw validationError("business_id query param is required");
    }

    if (storeIdParam === "me") {
      const stores = await this.service.listStores(this.operation(request, businessId));
      const store = stores.find((s) => s.isDefault) || stores[0];
      if (!store) throw notFoundError("Store not found");
      return { store };
    }

    const { storeId } = schemas.storeParamsSchema.pick({ storeId: true }).parse({
      storeId: storeIdParam,
    });
    return {
      store: await this.service.getStore(
        this.operation(request, businessId),
        storeId,
      ),
    };
  }, 200, schemas.storeResultSchema);

  readonly updateStore = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      store: await this.service.updateStore(
        this.operation(request, businessId),
        storeId,
        schemas.updateStoreSchema.parse(request.body),
      ),
    };
  }, 200, schemas.storeResultSchema);

  readonly archiveStore = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      store: await this.service.archiveStore(
        this.operation(request, businessId),
        storeId,
      ),
    };
  }, 200, schemas.storeResultSchema);

  readonly listLocations = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      locations: await this.service.listLocations(
        this.operation(request, businessId),
        storeId,
      ),
    };
  }, 200, schemas.locationsResultSchema);

  readonly createLocation = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      location: await this.service.createLocation(
        this.operation(request, businessId),
        storeId,
        schemas.locationSchema.parse(request.body),
      ),
    };
  }, 201, schemas.locationResultSchema);

  readonly updateLocation = this.handle(async (request) => {
    const { businessId, storeId, childId } = schemas.childParamsSchema.parse(
      request.params,
    );
    return {
      location: await this.service.updateLocation(
        this.operation(request, businessId),
        storeId,
        childId,
        schemas.updateLocationSchema.parse(request.body),
      ),
    };
  }, 200, schemas.locationResultSchema);

  readonly archiveLocation = this.handle(async (request) => {
    const { businessId, storeId, childId } = schemas.childParamsSchema.parse(
      request.params,
    );
    return {
      location: await this.service.archiveLocation(
        this.operation(request, businessId),
        storeId,
        childId,
      ),
    };
  }, 200, schemas.locationResultSchema);

  readonly listChannels = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      channels: await this.service.listChannels(
        this.operation(request, businessId),
        storeId,
      ),
    };
  }, 200, schemas.channelsResultSchema);

  readonly createChannel = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      channel: await this.service.createChannel(
        this.operation(request, businessId),
        storeId,
        schemas.channelSchema.parse(request.body),
      ),
    };
  }, 201, schemas.channelResultSchema);

  readonly updateChannel = this.handle(async (request) => {
    const { businessId, storeId, childId } = schemas.childParamsSchema.parse(
      request.params,
    );
    return {
      channel: await this.service.updateChannel(
        this.operation(request, businessId),
        storeId,
        childId,
        schemas.updateChannelSchema.parse(request.body),
      ),
    };
  }, 200, schemas.channelResultSchema);

  readonly archiveChannel = this.handle(async (request) => {
    const { businessId, storeId, childId } = schemas.childParamsSchema.parse(
      request.params,
    );
    return {
      channel: await this.service.archiveChannel(
        this.operation(request, businessId),
        storeId,
        childId,
      ),
    };
  }, 200, schemas.channelResultSchema);

  readonly listRegisters = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      registers: await this.service.listRegisters(
        this.operation(request, businessId),
        storeId,
      ),
    };
  }, 200, schemas.registersResultSchema);

  readonly createRegister = this.handle(async (request) => {
    const { businessId, storeId } = schemas.storeParamsSchema.parse(
      request.params,
    );
    return {
      register: await this.service.createRegister(
        this.operation(request, businessId),
        storeId,
        schemas.registerSchema.parse(request.body),
      ),
    };
  }, 201, schemas.registerResultSchema);

  readonly updateRegister = this.handle(async (request) => {
    const { businessId, storeId, registerId } =
      schemas.registerParamsSchema.parse(request.params);
    return {
      register: await this.service.updateRegister(
        this.operation(request, businessId),
        storeId,
        registerId,
        schemas.updateRegisterSchema.parse(request.body),
      ),
    };
  }, 200, schemas.registerResultSchema);

  readonly archiveRegister = this.handle(async (request) => {
    const { businessId, storeId, registerId } =
      schemas.registerParamsSchema.parse(request.params);
    return {
      register: await this.service.archiveRegister(
        this.operation(request, businessId),
        storeId,
        registerId,
      ),
    };
  }, 200, schemas.registerResultSchema);

  readonly getCurrentShift = this.handle(async (request) => {
    const { businessId, registerId } = schemas.registerParamsSchema.parse(
      request.params,
    );
    return {
      shift: await this.service.getCurrentShift(
        this.operation(request, businessId),
        registerId,
      ),
    };
  }, 200, schemas.shiftResultSchema);

  readonly openShift = this.handle(async (request) => {
    const { businessId, storeId, registerId } =
      schemas.registerParamsSchema.parse(request.params);
    const input = schemas.openShiftSchema.parse(request.body);
    return {
      shift: await this.service.openShift(
        this.operation(request, businessId),
        storeId,
        registerId,
        input.openingCashMinor,
      ),
    };
  }, 201, schemas.shiftResultSchema);

  readonly closeShift = this.handle(async (request) => {
    const { businessId, storeId, shiftId } = schemas.shiftParamsSchema.parse(
      request.params,
    );
    const input = schemas.closeShiftSchema.parse(request.body);
    return {
      shift: await this.service.closeShift(
        this.operation(request, businessId),
        storeId,
        shiftId,
        input.countedCashMinor,
        input.notes,
      ),
    };
  }, 200, schemas.shiftResultSchema);

  readonly listCashMovements = this.handle(async (request) => {
    const { businessId, shiftId } = schemas.shiftParamsSchema.parse(
      request.params,
    );
    return {
      cashMovements: await this.service.listCashMovements(
        this.operation(request, businessId),
        shiftId,
      ),
    };
  }, 200, schemas.cashMovementsResultSchema);

  readonly createCashMovement = this.handle(async (request) => {
    const { businessId, storeId, shiftId } = schemas.shiftParamsSchema.parse(
      request.params,
    );
    return {
      cashMovement: await this.service.createCashMovement(
        this.operation(request, businessId),
        storeId,
        shiftId,
        schemas.cashMovementSchema.parse(request.body),
      ),
    };
  }, 201, schemas.cashMovementResultSchema);

  private operation(request: Request, businessId: string): OperationContext {
    return {
      userId: requireAuthContext(request).userId,
      businessId,
      requestId: request.requestId,
    };
  }

  private handle<T>(
    work: (request: Request) => Promise<T>,
    statusCode = 200,
    responseSchema?: { parse(value: unknown): unknown },
  ) {
    return async (
      request: Request,
      response: Response,
      next: NextFunction,
    ): Promise<void> => {
      try {
        const result = await work(request);
        ApiResponse.success(
          response,
          responseSchema ? responseSchema.parse(result) : result,
          statusCode,
        );
      } catch (error) {
        next(error);
      }
    };
  }
}
