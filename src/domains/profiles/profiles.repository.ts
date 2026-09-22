import type { DatabaseContext } from "../../db/database-context.js";
import type { UserProfileRow } from "./profiles.types.js";

export async function findUserProfile(
  context: DatabaseContext,
  userId: string,
): Promise<UserProfileRow | undefined> {
  return context.transaction
    .selectFrom("user_profiles")
    .select([
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
    ])
    .where("userId", "=", userId)
    .executeTakeFirst();
}
