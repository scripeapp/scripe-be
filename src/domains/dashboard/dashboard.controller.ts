import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { DashboardService } from "./dashboard.service.js";

const PERIODS = ["today", "7 days", "14 days", "30 days", "90 days", "1 year"] as const;

const statsQuerySchema = z.object({
  business_id: z.string().uuid(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .default("NGN"),
  period: z.enum(PERIODS).default("90 days"),
});

/** Start of the window for a period label, or null for "all time". */
function periodStart(period: (typeof PERIODS)[number]): Date | null {
  const start = new Date();
  switch (period) {
    case "today":
      start.setHours(0, 0, 0, 0);
      return start;
    case "7 days":
      start.setDate(start.getDate() - 7);
      return start;
    case "14 days":
      start.setDate(start.getDate() - 14);
      return start;
    case "30 days":
      start.setDate(start.getDate() - 30);
      return start;
    case "90 days":
      start.setDate(start.getDate() - 90);
      return start;
    case "1 year":
      start.setFullYear(start.getFullYear() - 1);
      return start;
    default:
      return null;
  }
}

const storeAnalyticsQuerySchema = z.object({
  business_id: z.string().uuid(),
  store_id: z.string().uuid(),
  branch_id: z.string().uuid().optional(),
});

const POS_RANGES = ["7d", "30d", "all"] as const;
const posAnalyticsQuerySchema = z.object({
  business_id: z.string().uuid(),
  store_id: z.string().uuid(),
  range: z.enum(POS_RANGES).default("30d"),
});

function posRangeStart(range: (typeof POS_RANGES)[number]): Date | null {
  if (range === "all") return null;
  const start = new Date();
  start.setDate(start.getDate() - (range === "7d" ? 7 : 30));
  return start;
}

export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  readonly storeAnalytics = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const { business_id, store_id, branch_id } = storeAnalyticsQuerySchema.parse(request.query);
      const data = await this.service.storeAnalytics(
        { userId, requestId: request.requestId, businessId: business_id },
        store_id,
        branch_id ?? null,
      );
      ApiResponse.success(response, data);
    } catch (error) {
      next(error);
    }
  };

  readonly posAnalytics = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const { business_id, store_id, range } = posAnalyticsQuerySchema.parse(request.query);
      const data = await this.service.posAnalytics(
        { userId, requestId: request.requestId, businessId: business_id },
        store_id,
        posRangeStart(range),
      );
      ApiResponse.success(response, data);
    } catch (error) {
      next(error);
    }
  };

  readonly stats = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const { business_id, currency, period } = statsQuerySchema.parse(request.query);
      const data = await this.service.stats(
        { userId, requestId: request.requestId, businessId: business_id },
        currency,
        periodStart(period),
      );
      ApiResponse.success(response, data);
    } catch (error) {
      next(error);
    }
  };
}
