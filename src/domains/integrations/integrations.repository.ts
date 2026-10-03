import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";

export async function findMeetEnabled(context: DatabaseContext, userId: string): Promise<boolean> {
  const result = await sql<{ meetEnabled: boolean }>`
    select "meetEnabled" from app.calendar_connections where "userId" = ${userId}::uuid
  `.execute(context.transaction);
  return result.rows[0]?.meetEnabled ?? true;
}

export async function saveMeetEnabled(context: DatabaseContext, userId: string, meetEnabled: boolean): Promise<boolean> {
  const result = await sql<{ meetEnabled: boolean }>`
    insert into app.calendar_connections ("userId", "meetEnabled") values (${userId}::uuid, ${meetEnabled})
    on conflict ("userId") do update set "meetEnabled" = excluded."meetEnabled"
    returning "meetEnabled"
  `.execute(context.transaction);
  return result.rows[0]!.meetEnabled;
}
