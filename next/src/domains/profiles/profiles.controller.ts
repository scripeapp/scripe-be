import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { notFoundError } from "../../shared/errors.js";
import type { ProfilesService } from "./profiles.service.js";

export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  readonly getCurrentUser = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const user = await this.profilesService.getCurrentUser({
        principal: request.principal,
        emailVerified: requireAuthContext(request).emailVerified,
      });
      if (!user) {
        next(notFoundError("Profile not found"));
        return;
      }
      ApiResponse.success(response, { user });
    } catch (error) {
      next(error);
    }
  };
}
