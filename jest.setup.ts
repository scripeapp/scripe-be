import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const environmentPath = path.resolve(__dirname, ".env");

if (existsSync(environmentPath)) {
  for (const rawLine of readFileSync(environmentPath, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Better Auth disables origin/CSRF validation when NODE_ENV is "test"
// (its isTest() shortcut). Run tests as "development" so those guards stay
// active and are actually exercised.
process.env.NODE_ENV = "development";