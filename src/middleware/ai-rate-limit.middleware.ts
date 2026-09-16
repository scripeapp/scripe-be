/**
 * In-memory per-business rate limiting for AI endpoints. Extracted from
 * ai.routes.ts so the text-enhance routes and the dashboard-agent routes
 * share one implementation with different limits.
 */
import { Request, Response, NextFunction } from "express";

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_WINDOW = 60 * 1000; // 1 minute in ms

export function createAiRateLimit(scope: string, limit: number) {
  return function aiRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const businessId = (req as any).businessId || req.body?.business_id;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "business_id_required",
        message: "Business ID is required",
      });
    }

    const now = Date.now();
    const key = `${scope}:${businessId}`;
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetTime) {
      rateLimitMap.set(key, { count: 1, resetTime: now + RATE_WINDOW });
      return next();
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        success: false,
        error: "rate_limit_exceeded",
        message: `Too many AI requests. Try again in ${retryAfter} seconds.`,
        retryAfter,
      });
    }

    entry.count++;
    return next();
  };
}
