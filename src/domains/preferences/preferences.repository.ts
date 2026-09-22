import { sql } from "kysely";
import type { Json } from "../../db/database.types.codegen.js";
import type { DatabaseContext } from "../../db/database-context.js";

function asObject(value: Json | null | undefined): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

export async function getPreferences(context: DatabaseContext, userId: string): Promise<Record<string, unknown>> {
  const row = await context.transaction
    .selectFrom("user_profiles")
    .select("preferences")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return asObject(row?.preferences);
}

/** Shallow-merges patch into the existing preferences object (Postgres jsonb `||`); a key set to null overwrites rather than removes. */
export async function mergePreferences(context: DatabaseContext, userId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const row = await context.transaction
    .updateTable("user_profiles")
    .set({ preferences: sql`"preferences" || ${JSON.stringify(patch)}::jsonb` })
    .where("userId", "=", userId)
    .returning("preferences")
    .executeTakeFirst();
  return row ? asObject(row.preferences) : undefined;
}
