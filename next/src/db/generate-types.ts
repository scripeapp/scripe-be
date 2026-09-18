import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadEnvironment } from "../shared/environment.js";

const OUT_FILE = path.join(import.meta.dirname, "database.types.codegen.ts");
const CODEGEN_BIN = path.join(
  import.meta.dirname,
  "..",
  "..",
  "node_modules",
  ".bin",
  "kysely-codegen",
);

function main(): void {
  const environment = loadEnvironment();
  const migrateUrl = environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL;

  execFileSync(
    CODEGEN_BIN,
    [
      "--dialect",
      "postgres",
      "--url",
      migrateUrl,
      "--default-schema",
      "app",
      "--exclude-pattern",
      "auth.*",
      "--out-file",
      OUT_FILE,
      "--type-only-imports",
    ],
    { stdio: "inherit" },
  );

  console.log(`Generated ${OUT_FILE}`);
}

void main();
