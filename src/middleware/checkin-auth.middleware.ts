import { Request, Response, NextFunction } from "express";
import { checkinService } from "../services/checkin.service";
import { supabaseAdmin } from "../config/supabase";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";
import { authenticateUser } from "./supabase-auth-middleware";

const CHECKIN_TOKEN_HEADER = "x-checkin-token";

/**
 * Middleware that accepts either a standard user session or a short-lived
 * check-in token (issued by POST /api/checkin/auth).
 *
 * When a valid check-in token is present:
 *   - req.checkinEventId is set to the token's event_id
 *   - req.supabase is set to the service-role admin client (bypasses RLS;
 *     the application-level event-match check replaces row-level policy)
 *
 * When no check-in token is found, it falls through to standard user auth.
 */
export const authenticateCheckinOrUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const checkinToken = req.headers[CHECKIN_TOKEN_HEADER] as string | undefined;

  if (checkinToken) {
    const payload = checkinService.verifyCheckinToken(checkinToken);
    if (!payload) {
      return ApiResponse.unauthorized(
        res,
        "Invalid or expired check-in token",
      );
    }
    (req as SupabaseRequest).checkinEventId = payload.event_id;
    (req as SupabaseRequest).supabase = supabaseAdmin;
    return next();
  }

  return authenticateUser(req, res, next);
};
