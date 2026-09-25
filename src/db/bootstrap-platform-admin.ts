/**
 * One-time operator bootstrap for the *first* platform administrator.
 *
 * There is no API endpoint for this and there must never be one: every
 * platform.administrators route requires the caller to already be an active
 * administrator (see domains/platform/platform.service.ts), so the very
 * first grant has to happen out-of-band. This connects as scripe_migrator
 * (schema owner, exempt from RLS by default) rather than the runtime
 * scripe_app role - a deliberate, narrow exception to "runtime never connects
 * as a schema owner" for a script a human runs by hand, once, never as part
 * of request traffic.
 *
 * Usage:
 *   bun src/db/bootstrap-platform-admin.ts <email> [role]
 *
 * The email must already belong to a signed-up Better Auth user (auth.user);
 * this script does not create accounts, only grants platform-admin status to
 * one that exists. role defaults to "super_admin".
 */

import { Pool } from "pg";
import { loadEnvironment } from "../shared/environment.js";

const ROLES = ["super_admin", "finance", "support", "moderator", "viewer"] as const;

async function main(): Promise<void> {
  const [email, roleArgument] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: bun src/db/bootstrap-platform-admin.ts <email> [role]");
    process.exitCode = 1;
    return;
  }
  const role = roleArgument ?? "super_admin";
  if (!ROLES.includes(role as (typeof ROLES)[number])) {
    console.error(`Invalid role "${role}". Expected one of: ${ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const environment = loadEnvironment();
  const connectionString = environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL;
  const pool = new Pool({ connectionString });

  try {
    const user = await pool.query<{ id: string; email: string; name: string }>(
      `select "id", "email", "name" from auth.user where lower("email") = lower($1)`,
      [email],
    );
    if (user.rows.length === 0) {
      console.error(`No account found for ${email}. The person must sign up first.`);
      process.exitCode = 1;
      return;
    }
    const target = user.rows[0]!;

    const result = await pool.query<{ id: string; role: string; isActive: boolean }>(
      `insert into app.platform_administrators ("userId", "role", "name", "email")
       values ($1, $2, $3, $4)
       on conflict ("userId") do update set "role" = excluded."role", "isActive" = true
       returning "id", "role", "isActive"`,
      [target.id, role, target.name, target.email],
    );
    console.log(`Granted ${target.email} platform administrator access (role: ${result.rows[0]!.role}, id: ${result.rows[0]!.id}).`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
