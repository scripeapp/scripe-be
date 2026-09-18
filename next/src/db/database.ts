import { Kysely, PostgresDialect, sql } from "kysely";
import type { Pool } from "pg";
import {
  type Database,
  type SurgeDatabaseTables,
} from "./database.types.js";

export interface DatabaseGateway {
  readonly database: Database;
  readonly pool: Pool;
  checkReachability(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabaseGateway(pool: Pool): DatabaseGateway {
  const database = new Kysely<SurgeDatabaseTables>({
    dialect: new PostgresDialect({ pool }),
  }).withSchema("app");

  return {
    database,
    pool,
    async checkReachability() {
      const row = await sql<{ datname: string }>`
        select datname
        from pg_catalog.pg_database
        limit 1
      `.execute(database);
      return row.rows.length === 1;
    },
    async close() {
      await pool.end();
    },
  };
}

let databaseGateway: DatabaseGateway | undefined;

export function configureDatabaseGateway(gateway: DatabaseGateway): void {
  if (databaseGateway) {
    throw new Error("Database gateway is already configured.");
  }
  databaseGateway = gateway;
}

export function getDatabase(): Database {
  return requireDatabaseGateway().database;
}

export function getDatabaseGateway(): DatabaseGateway {
  return requireDatabaseGateway();
}

export async function closeDatabase(): Promise<void> {
  const gateway = databaseGateway;
  databaseGateway = undefined;
  if (gateway) {
    await gateway.close();
  }
}

function requireDatabaseGateway(): DatabaseGateway {
  if (!databaseGateway) {
    throw new Error("Database gateway has not been configured.");
  }
  return databaseGateway;
}
