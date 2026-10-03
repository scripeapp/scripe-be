import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { notFoundError } from "../../shared/errors.js";
import {
  brandingImageParamsSchema,
  businessIdParamsSchema,
  createBusinessSchema,
  updateBrandingSchema,
  updateBusinessSchema,
} from "./businesses.schemas.js";
import type { BusinessesService } from "./businesses.service.js";
import type { BusinessOperation } from "./businesses.types.js";
import { DEFAULT_BUSINESS_CATEGORIES } from "./businesses.categories.js";

export class BusinessesController {
  constructor(private readonly service: BusinessesService) {}

  readonly listCategories = this.handle(async () => ({
    categories: DEFAULT_BUSINESS_CATEGORIES,
  }));

  readonly list = this.handle(async (request) => ({
    businesses: await this.service.list(this.operation(request)),
  }));

  readonly create = this.handle(
    async (request) => ({
      business: await this.service.create(
        this.operation(request),
        createBusinessSchema.parse(request.body),
      ),
    }),
    201,
  );

  readonly updateBranding = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    return {
      business: await this.service.updateBranding(this.operation(request), businessId, updateBrandingSchema.parse(request.body)),
    };
  });

  /** Public: no requireAuth. Colours and image URLs for a business's public pages. */
  readonly getPublicBranding = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { businessId } = businessIdParamsSchema.parse(request.params);
      ApiResponse.success(response, { branding: await this.service.getPublicBranding(request.requestId, businessId) });
    } catch (error) {
      next(error);
    }
  };

  /** Public: redirects to a short-lived download URL for the logo or icon (like /api/users/:userId/avatar). */
  readonly getBrandingImage = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { businessId, kind } = brandingImageParamsSchema.parse(request.params);
      const downloadUrl = await this.service.resolveBrandingImageUrl(request.requestId, businessId, kind);
      if (!downloadUrl) {
        next(notFoundError("Image not found"));
        return;
      }
      // ?v= in the path changes with the image, so the redirect itself can be cached briefly.
      response.set("Cache-Control", "public, max-age=300");
      response.redirect(302, downloadUrl);
    } catch (error) {
      next(error);
    }
  };

  readonly get = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    return {
      business: await this.service.get(this.operation(request), businessId),
    };
  });

  readonly update = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    return {
      business: await this.service.update(
        this.operation(request),
        businessId,
        updateBusinessSchema.parse(request.body),
      ),
    };
  });

  readonly archive = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    await this.service.archive(this.operation(request), businessId);
    return { archived: true };
  });

  private operation(request: Request): BusinessOperation {
    return {
      userId: requireAuthContext(request).userId,
      requestId: request.requestId,
    };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (
      request: Request,
      response: Response,
      next: NextFunction,
    ): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
