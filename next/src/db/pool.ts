import { Pool, type PoolConfig } from "pg";
import { loadEnvironment } from "../shared/environment.js";

const SSL_OPTIONS = { rejectUnauthorized: true };

export function createDatabasePool(): Pool {
  const environment = loadEnvironment();

  const config: PoolConfig = {
    connectionString: environment.DATABASE_URL,
    max: environment.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: environment.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: environment.DATABASE_STATEMENT_TIMEOUT_MS,
    allowExitOnIdle: false,
  };

  if (environment.DATABASE_SSL_MODE === "require") {
    config.ssl = SSL_OPTIONS;
  }

  return new Pool(config);
}

export function configurePoolErrorHandling(pool: Pool): void {
  pool.on("error", (error) => {
    console.error("[database] idle client error", error);
  });
}
