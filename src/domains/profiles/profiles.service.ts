import type { Json } from "../../db/database.types.codegen.js";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import type { Principal } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import { findUserProfile, updateUserProfile } from "./profiles.repository.js";
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

  private toCurrentUser(
    profile: UserProfileRow,
    emailVerified: boolean,
  ): CurrentUser {
    return {
      id: profile.userId,
      email: profile.email,
      name: profile.name,
      image: profile.image,
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
