import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sql } from "kysely";
import { getDatabase } from "../db/database.js";
import { withDatabaseContext } from "../db/database-context.js";
import { anonymousPrincipal } from "../db/principal.js";
import { rateLimitedError } from "../shared/errors.js";

export interface RateLimitRule {
  /** Distinguishes this limit's counters from every other limit's. */
  readonly name: string;
  readonly windowSeconds: number;
  readonly max: number;
  /** The counter key for this request, e.g. the client IP or a route param; null skips this rule. */
  readonly key: (request: Request) => string | null;
}

/**
 * Fixed-window limits backed by app.consume_rate_limit (migration 0081), so
 * the counters hold across every API instance. Each rule is checked in
 * order; the first exhausted one answers 429. Client IPs come from req.ip,
 * which is only the real client when TRUST_PROXY_HOPS matches the number
 * of proxies in front of the API.
 */
export function rateLimit(...rules: RateLimitRule[]): RequestHandler {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const allowed = await withDatabaseContext(getDatabase(), anonymousPrincipal(request.requestId), async (context) => {
        for (const rule of rules) {
          const key = rule.key(request);
          if (!key) continue;
          const result = await sql<{ allowed: boolean }>`
            select app.consume_rate_limit(${`${rule.name}:${key}`}, ${rule.windowSeconds}, ${rule.max}) as "allowed"
          `.execute(context.transaction);
          if (!result.rows[0]?.allowed) return false;
        }
        return true;
      });
      if (!allowed) return next(rateLimitedError("Too many requests. Please wait a moment and try again."));
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const clientIp = (request: Request): string | null => request.ip ?? request.socket.remoteAddress ?? null;
