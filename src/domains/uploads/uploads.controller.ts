import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./uploads.schemas.js";
import type { UploadsService } from "./uploads.service.js";
import type { UploadsOperation } from "./uploads.types.js";

export class UploadsController {
  constructor(private readonly service: UploadsService) {}

  readonly create = this.handle(
    (request) => this.service.create(this.operation(request), schemas.createUploadSchema.parse(request.body)),
    201,
  );

  readonly list = this.handle(async (request) => {
    const { businessId, purpose } = schemas.listQuerySchema.parse(request.query);
    const uploads = businessId
      ? await this.service.listForBusiness(this.operation(request), businessId, purpose)
      : await this.service.listForSelf(this.operation(request), purpose);
    return { uploads };
  });

  readonly get = this.handle(async (request) => {
    const { uploadId } = schemas.uploadParamsSchema.parse(request.params);
    return { upload: await this.service.get(this.operation(request), uploadId) };
  });

  readonly confirm = this.handle(async (request) => {
    const { uploadId } = schemas.uploadParamsSchema.parse(request.params);
    return { upload: await this.service.confirm(this.operation(request), uploadId) };
  });

  readonly remove = this.handle(async (request) => {
    const { uploadId } = schemas.uploadParamsSchema.parse(request.params);
    await this.service.remove(this.operation(request), uploadId);
    return { deleted: true };
  });

  private operation(request: Request): UploadsOperation {
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
