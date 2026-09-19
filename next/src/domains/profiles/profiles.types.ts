import type { Selectable } from "kysely";
import type { UserProfiles } from "../../db/database.types.codegen.js";

export type UserProfileRow = Selectable<UserProfiles>;

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly image: string | null;
  readonly emailVerified: boolean;
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string | null;
  readonly bio: string;
  readonly website: string;
  readonly location: string;
  readonly phoneNumber: string;
  readonly gender: string;
  readonly socialLinks: Record<string, unknown>;
  readonly accountStatus: string;
  readonly accountType: string;
  readonly preferences: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CurrentUserResponse {
  readonly user: CurrentUser;
}
