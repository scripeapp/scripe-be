import { Request, Response, NextFunction } from "express";

/**
 * Simple in-memory rate limiter.
 * For production, replace the store with Redis.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

function getClientId(req: Request): string {
  // Prefer authenticated user ID, fall back to IP
  const user = (req as any).user;
  if (user?.id) return `user:${user.id}`;
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  return `ip:${ip}`;
}

/**
 * Creates a rate-limit middleware.
 *
 * @param windowMs   Time window in milliseconds
 * @param max        Max requests per window
 * @param message    Error message when limit is exceeded
 */
export function rateLimit(
  windowMs: number,
  max: number,
  message = "Too many requests. Please slow down.",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.path}:${getClientId(req)}`;
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", "0");
      res.set("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
      return res.status(429).json({
        success: false,
        message,
        retry_after_seconds: retryAfter,
      });
    }

    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(max - entry.count));
    res.set("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
    return next();
  };
}

// ============================================================
// Pre-built limiters for different endpoint types
// ============================================================

/** Strict limiter for auth endpoints (login, register, OTP) */
export const authRateLimit = rateLimit(
  15 * 60 * 1000, // 15 minutes
  20,
  "Too many authentication attempts. Try again in 15 minutes.",
);

/** General API limiter — 300 requests / minute */
export const apiRateLimit = rateLimit(
  60 * 1000,
  300,
  "API rate limit exceeded. Please slow down.",
);

/** Webhook ingestion limiter */
export const webhookRateLimit = rateLimit(
  60 * 1000,
  60,
  "Webhook rate limit exceeded.",
);

/** Admin action limiter — prevents admin UI abuse */
export const adminActionRateLimit = rateLimit(
  60 * 1000,
  100,
  "Too many admin actions. Please wait.",
);

/** Sensitive write operations (plan changes, payments) */
export const sensitiveRateLimit = rateLimit(
  10 * 60 * 1000, // 10 minutes
  30,
  "Too many requests. Please wait 10 minutes before retrying.",
);
