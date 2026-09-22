import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./addresses.schemas.js";
import type { AddressesService } from "./addresses.service.js";
import type { AddressesOperation } from "./addresses.types.js";

export class AddressesController {
  constructor(private readonly service: AddressesService) {}

  readonly list = this.handle(async (request) => ({
    addresses: await this.service.list(this.operation(request)),
  }));

  readonly create = this.handle(async (request) => ({
    address: await this.service.create(this.operation(request), schemas.createAddressSchema.parse(request.body)),
  }), 201);

  readonly update = this.handle(async (request) => {
    const { addressId } = schemas.addressParamsSchema.parse(request.params);
    return { address: await this.service.update(this.operation(request), addressId, schemas.updateAddressSchema.parse(request.body)) };
  });

  readonly remove = this.handle(async (request) => {
    const { addressId } = schemas.addressParamsSchema.parse(request.params);
    await this.service.remove(this.operation(request), addressId);
    return { removed: true };
  });

  private operation(request: Request): AddressesOperation {
    return {
      userId: requireAuthContext(request).userId,
      requestId: request.requestId,
    };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
