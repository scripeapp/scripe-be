import cors from "cors";
import type { CorsOptions } from "cors";
import { loadEnvironment } from "../shared/environment.js";
import { forbiddenError } from "../shared/errors.js";

type CustomOriginCallback = Parameters<
  Extract<NonNullable<CorsOptions["origin"]>, (...args: never[]) => unknown>
>;

export function createCorsOptions(): CorsOptions {
  const environment = loadEnvironment();
  const trustedOrigins = new Set([
    environment.BETTER_AUTH_URL,
    ...environment.AUTH_TRUSTED_ORIGINS,
  ]);

  return {
    origin(...[origin, callback]: CustomOriginCallback) {
      if (!origin || isTrustedOrigin(origin, trustedOrigins)) {
        callback(null, true);
        return;
      }
      callback(forbiddenError("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  };
}

function isTrustedOrigin(origin: string, trustedOrigins: Set<string>): boolean {
  if (trustedOrigins.has(origin)) return true;

  for (const trustedOrigin of trustedOrigins) {
    if (!trustedOrigin.endsWith(":*")) continue;
    try {
      const candidate = new URL(origin);
      const trusted = new URL(trustedOrigin.slice(0, -2));
      if (
        candidate.protocol === trusted.protocol &&
        candidate.hostname === trusted.hostname
      ) {
        return true;
      }
    } catch {
      // Invalid configured origins never match.
    }
  }
  return false;
}

export { cors };
