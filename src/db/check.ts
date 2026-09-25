import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { loadEnvironment } from "../shared/environment.js";
import type { ScripeDatabaseTables } from "./database.types.js";

type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

const SUPERUSER_ROLE = "postgres";

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const migratorUrl = environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL;
  const appUrl = environment.DATABASE_URL;

  const results: CheckResult[] = [];
  results.push(...(await checkMigratorConnection(migratorUrl)));
  results.push(...(await checkRuntimeConnection(appUrl)));

  report(results);
}

function createDatabase(url: string): { database: Kysely<ScripeDatabaseTables>; pool: Pool } {
  const pool = new Pool({ connectionString: url });
  const database = new Kysely<ScripeDatabaseTables>({
    dialect: new PostgresDialect({ pool }),
  });
  return { database, pool };
}

async function checkMigratorConnection(url: string): Promise<CheckResult[]> {
  const { database, pool } = createDatabase(url);
  try {
    const migrations = await sql<{ name: string }>`
      select name from public.kysely_migration order by name
    `.execute(database);
    return [
      {
        name: "migrations",
        status: migrations.rows.length > 0 ? "pass" : "fail",
        detail: `${migrations.rows.length} migration(s) applied`,
      },
    ];
  } finally {
    await pool.end();
  }
}

async function checkRuntimeConnection(url: string): Promise<CheckResult[]> {
  const { database, pool } = createDatabase(url);
  const results: CheckResult[] = [];
  try {
    const roles = await sql<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>`
      select r.rolsuper, r.rolbypassrls, current_user
      from pg_roles r
      where r.rolname = current_user
    `.execute(database);

    const role = roles.rows[0];
    if (!role) {
      results.push({
        name: "runtime-role",
        status: "fail",
        detail: "cannot resolve the connected runtime role",
      });
      return results;
    }

    results.push({
      name: "runtime-role-is-not-superuser",
      status: role.rolsuper ? "fail" : "pass",
      detail: `${role.current_user} rolsuper=${role.rolsuper}`,
    });
    results.push({
      name: "runtime-role-has-no-bypassrls",
      status: role.rolbypassrls ? "fail" : "pass",
      detail: `${role.current_user} rolbypassrls=${role.rolbypassrls}`,
    });
    results.push({
      name: "runtime-role-is-not-postgres-superuser",
      status: role.current_user === SUPERUSER_ROLE ? "fail" : "pass",
      detail: `connected as ${role.current_user}`,
    });
    return results;
  } catch (error) {
    results.push({
      name: "runtime-connection",
      status: "fail",
      detail: error instanceof Error ? error.message : "unknown error",
    });
    return results;
  } finally {
    await pool.end();
  }
}

function report(results: CheckResult[]): void {
  let failed = false;
  for (const result of results) {
    const marker = result.status === "pass" ? "ok" : result.status;
    console.log(`[${marker}] ${result.name}: ${result.detail}`);
    if (result.status === "fail") {
      failed = true;
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
