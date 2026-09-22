import type { Json } from "../../db/database.types.codegen.js";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, type Principal } from "../../db/principal.js";
import { objectStorage } from "../../integrations/r2.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import { requireOwnConfirmedUpload } from "../uploads/uploads.service.js";
import { findConfirmedAvatarObjectKey, findUserProfile, setAvatarUploadId, updateUserProfile } from "./profiles.repository.js";
import type { CurrentUser, UpdateUserProfileInput, UserProfileRow } from "./profiles.types.js";

interface CurrentUserQuery {
  readonly principal: Principal;
  readonly emailVerified: boolean;
}

export class ProfilesService {
  constructor(private readonly database: Database) {}

  async getCurrentUser(
    query: CurrentUserQuery,
  ): Promise<CurrentUser | undefined> {
    const userId = query.principal.userId;
    if (!userId) return undefined;

    const profile = await withDatabaseContext(
      this.database,
      query.principal,
      (context) => findUserProfile(context, userId),
    );
    if (!profile) return undefined;

    return this.toCurrentUser(profile, query.emailVerified);
  }

  async updateCurrentUser(
    query: CurrentUserQuery,
    patch: UpdateUserProfileInput,
  ): Promise<CurrentUser> {
    const userId = query.principal.userId;
    if (!userId) throw notFoundError("Profile not found");

    try {
      const profile = await withDatabaseContext(
        this.database,
        query.principal,
        (context) => updateUserProfile(context, userId, patch),
      );
      if (!profile) throw notFoundError("Profile not found");
      return this.toCurrentUser(profile, query.emailVerified);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }

  async setAvatar(query: CurrentUserQuery, uploadId: string): Promise<CurrentUser> {
    const userId = query.principal.userId;
    if (!userId) throw notFoundError("Profile not found");

    try {
      const profile = await withDatabaseContext(this.database, query.principal, async (context) => {
        await requireOwnConfirmedUpload(context, userId, uploadId, "avatar");
        return setAvatarUploadId(context, userId, uploadId);
      });
      if (!profile) throw notFoundError("Profile not found");
      return this.toCurrentUser(profile, query.emailVerified);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }

  /** Anonymous on purpose — an avatar is public once linked, and this is the one path allowed to see behind another user's private upload row (migration 0045's SECURITY DEFINER function). Presigned URLs expire, so this is resolved fresh per request rather than stored. */
  async resolveAvatarDownloadUrl(userId: string, requestId: string): Promise<string | null> {
    const objectKey = await withDatabaseContext(this.database, anonymousPrincipal(requestId), (context) =>
      findConfirmedAvatarObjectKey(context, userId),
    );
    if (!objectKey) return null;
    return objectStorage.createPresignedDownloadUrl(objectKey);
  }

  private toCurrentUser(
    profile: UserProfileRow,
    emailVerified: boolean,
  ): CurrentUser {
    return {
      id: profile.userId,
      email: profile.email,
      name: profile.name,
      image: profile.image,
      avatarUrl: profile.avatarUploadId ? `/api/users/${profile.userId}/avatar` : null,
      emailVerified,
      firstName: profile.firstName,
      lastName: profile.lastName,
      username: profile.username,
      bio: profile.bio,
      website: profile.website,
      location: profile.location,
      phoneNumber: profile.phoneNumber,
      gender: profile.gender,
      socialLinks: this.asObject(profile.socialLinks),
      accountStatus: profile.accountStatus,
      accountType: profile.accountType,
      preferences: this.asObject(profile.preferences),
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }

  private asObject(value: Json): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return {};
  }
}
