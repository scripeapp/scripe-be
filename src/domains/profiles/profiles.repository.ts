import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { UpdateUserProfileInput, UserProfileRow } from "./profiles.types.js";

const PROFILE_COLUMNS = [
  "userId",
  "email",
  "name",
  "image",
  "firstName",
  "lastName",
  "username",
  "bio",
  "website",
  "location",
  "phoneNumber",
  "gender",
  "socialLinks",
  "accountStatus",
  "accountType",
  "preferences",
  "createdAt",
  "updatedAt",
] as const;

export async function findUserProfile(
  context: DatabaseContext,
  userId: string,
): Promise<UserProfileRow | undefined> {
  return context.transaction
    .selectFrom("user_profiles")
    .select(PROFILE_COLUMNS)
    .where("userId", "=", userId)
    .executeTakeFirst();
}

/** Column-present fields only: a Zod `.partial()` update sends just what the caller set, never overwriting the rest with defaults. `socialLinks` is cast through `sql` like preferences.mergePreferences — Kysely's typed `.set()` does not serialize jsonb columns for this pg setup. */
export async function updateUserProfile(
  context: DatabaseContext,
  userId: string,
  patch: UpdateUserProfileInput,
): Promise<UserProfileRow | undefined> {
  const { socialLinks, ...rest } = patch;
  return context.transaction
    .updateTable("user_profiles")
    .set({
      ...rest,
      ...(socialLinks !== undefined ? { socialLinks: sql`${JSON.stringify(socialLinks)}::jsonb` } : {}),
      updatedAt: new Date(),
    })
    .where("userId", "=", userId)
    .returning(PROFILE_COLUMNS)
    .executeTakeFirst();
}
