import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Kysely,
  PostgresDialect,
  sql,
} from "kysely";
import {
  Migrator,
  NO_MIGRATIONS,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from "kysely/migration";
import { Pool } from "pg";

const MIGRATIONS_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export type MigrationCommand = "up" | "down" | "down-all" | "status" | "reset";

interface DatabaseCommandOptions {
  readonly resetAllowed?: boolean;
}

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly downSql: string | null;
}

export async function executeDatabaseCommand(
  databaseUrl: string,
  command: MigrationCommand,
  options: DatabaseCommandOptions = {},
): Promise<MigrationResult[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const database = createMigrationDatabase(pool);
    if (command === "reset") {
      if (!options.resetAllowed) {
        throw new Error(
          "Database reset refused. Set ALLOW_DATABASE_RESET=true outside production to confirm.",
        );
      }
      await dropApplicationSchemas(database);
      return await runMigrator(database, "up");
    }
    return await runMigrator(database, command);
  } finally {
    await pool.end();
  }
}

function createMigrationDatabase(pool: Pool) {
  return new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool }),
  });
}

async function runMigrator(
  database: Kysely<Record<string, unknown>>,
  command: "up" | "down" | "down-all" | "status",
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db: database,
    provider: await createSqlMigrationProvider(),
  });

  if (command === "status") {
    const migrationInfo = await migrator.getMigrations();
    const applied = await getAppliedMigrations(database);
    return migrationInfo.map((info) => {
      const isApplied = applied.has(info.name);
      return {
        migrationName: info.name,
        status: isApplied ? ("Success" as const) : ("NotExecuted" as const),
        direction: isApplied ? ("Up" as const) : ("Down" as const),
      };
    });
  }

  const result =
    command === "down"
      ? await migrator.migrateDown()
      : command === "down-all"
        ? await migrator.migrateTo(NO_MIGRATIONS)
        : await migrator.migrateToLatest();
  const error = result.error;
  if (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(typeof error === "string" ? error : JSON.stringify(error));
  }
  return result.results ?? [];
}

async function createSqlMigrationProvider(): Promise<SqlMigrationProvider> {
  const files = await loadMigrationFiles();
  return new SqlMigrationProvider(files);
}

class SqlMigrationProvider implements MigrationProvider {
  private readonly migrations: MigrationFile[];

  constructor(migrations: MigrationFile[]) {
    this.migrations = migrations;
  }

  getMigrations(): Promise<Record<string, Migration>> {
    const migrationMap: Record<string, Migration> = {};
    for (const file of this.migrations) {
      migrationMap[file.name] = {
        async up(database) {
          await sql.raw(file.sql).execute(database);
        },
        async down(database) {
          if (file.downSql) {
            await sql.raw(file.downSql).execute(database);
            return;
          }
          throw new Error(`Down migration not provided for ${file.name}.`);
        },
      };
    }
    return Promise.resolve(migrationMap);
  }
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await fs.readdir(MIGRATIONS_DIRECTORY);
  const sqlFiles = entries
    .filter((entry) => entry.endsWith(".sql") && !entry.endsWith(".down.sql"))
    .sort();

  const migrations: MigrationFile[] = [];
  for (const file of sqlFiles) {
    const stem = path.parse(file).name;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIRECTORY, file), "utf-8");
    const downFile = path.join(MIGRATIONS_DIRECTORY, `${stem}.down.sql`);
    const downSql = await fs
      .readFile(downFile, "utf-8")
      .catch(() => null);
    migrations.push({ name: stem, sql, downSql });
  }
  return migrations;
}

async function getAppliedMigrations(
  database: Kysely<Record<string, unknown>>,
): Promise<Set<string>> {
  try {
    const rows = await sql<{ name: string }>`
      select name
      from public.kysely_migration
    `.execute(database);
    return new Set(rows.rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

async function dropApplicationSchemas(
  database: Kysely<Record<string, unknown>>,
): Promise<void> {
  // Reset only the schemas and migration metadata owned by this application.
  // Never enumerate/drop arbitrary database schemas: a shared database may
  // contain unrelated data even in development or CI.
  await sql.raw(`
    drop schema if exists app cascade;
    drop schema if exists auth cascade;
    drop table if exists public.kysely_migration_lock;
    drop table if exists public.kysely_migration;
  `).execute(database);
}
