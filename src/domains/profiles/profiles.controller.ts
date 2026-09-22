import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { notFoundError } from "../../shared/errors.js";
import { avatarParamsSchema, setAvatarSchema, updateCurrentUserSchema } from "./profiles.schemas.js";
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

  readonly updateCurrentUser = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const patch = updateCurrentUserSchema.parse(request.body);
      const user = await this.profilesService.updateCurrentUser(
        {
          principal: request.principal,
          emailVerified: requireAuthContext(request).emailVerified,
        },
        patch,
      );
      ApiResponse.success(response, { user });
    } catch (error) {
      next(error);
    }
  };

  readonly setAvatar = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { uploadId } = setAvatarSchema.parse(request.body);
      const user = await this.profilesService.setAvatar(
        {
          principal: request.principal,
          emailVerified: requireAuthContext(request).emailVerified,
        },
        uploadId,
      );
      ApiResponse.success(response, { user });
    } catch (error) {
      next(error);
    }
  };

  /** Public — no requireAuth on this route. A confirmed avatar is meant to be viewable by anyone, not just its owner. */
  readonly getAvatar = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { userId } = avatarParamsSchema.parse(request.params);
      const downloadUrl = await this.profilesService.resolveAvatarDownloadUrl(userId, request.requestId);
      if (!downloadUrl) {
        next(notFoundError("Avatar not found"));
        return;
      }
      response.redirect(302, downloadUrl);
    } catch (error) {
      next(error);
    }
  };
}
