import type { Pool } from "pg";
import { sql } from "kysely";
import { loadEnvironment } from "../shared/environment.js";
import {
  closeDatabase,
  configureDatabaseGateway,
  createDatabaseGateway,
  getDatabase,
} from "./database.js";
import { createDatabasePool, configurePoolErrorHandling } from "./pool.js";

async function main(): Promise<void> {
  loadEnvironment();
  const pool = createDatabasePool();
  configurePoolErrorHandling(pool);
  configureDatabaseGateway(createGateway(pool));

  await runSeedData();

  await closeDatabase();
}

function createGateway(pool: Pool) {
  return createDatabaseGateway(pool);
}

async function runSeedData(): Promise<void> {
  const database = getDatabase();
  const row = await sql<{ datname: string }>`
    select datname
    from pg_catalog.pg_database
    limit 1
  `.execute(database);
  if (row.rows.length > 0) {
    console.log("Seed runner connected. No seed data defined yet.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
