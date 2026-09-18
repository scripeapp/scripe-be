import { loadEnvironment, type Environment } from "../shared/environment.js";
import {
  executeDatabaseCommand,
  type MigrationCommand,
} from "./migrate.js";

import type { MigrationResult } from "kysely/migration";

const VALID_COMMANDS: MigrationCommand[] = [
  "up",
  "down",
  "down-all",
  "status",
  "reset",
];

async function main(): Promise<void> {
  const command = parseCommand();
  const environment = loadEnvironment();
  const migrateUrl = resolveMigrateUrl(environment);
  const resetAllowed =
    environment.NODE_ENV !== "production" && environment.ALLOW_DATABASE_RESET;
  const results = await executeDatabaseCommand(migrateUrl, command, { resetAllowed });
  logResults(results);
}

function resolveMigrateUrl(environment: Environment): string {
  const migrateUrl = environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL;
  if (!environment.DATABASE_MIGRATE_URL) {
    console.warn(
      "[db] DATABASE_MIGRATE_URL is not set; running migrations with DATABASE_URL. Configure a migrator role for shared/staging environments.",
    );
  }
  return migrateUrl;
}

function parseCommand(): MigrationCommand {
  const input = process.argv[2] ?? "up";
  if (!VALID_COMMANDS.includes(input as MigrationCommand)) {
    throw new Error(
      `Unknown command "${input}". Expected one of: ${VALID_COMMANDS.join(", ")}`,
    );
  }
  return input as MigrationCommand;
}

function logResults(results: MigrationResult[]): void {
  results.forEach((result) => {
    if (result.status === "Success") {
      const action = result.direction === "Down" ? "Reverted" : "Applied";
      console.log(`${action}: ${result.migrationName}`);
    } else if (result.status === "NotExecuted") {
      console.log(`Not executed: ${result.migrationName}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
