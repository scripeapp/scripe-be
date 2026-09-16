/**
 * Supabase Authentication Middleware (v2 Compatible)
 *
 * Provides middleware for authenticating requests using Supabase tokens.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "../config/supabase";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ApiResponse from "../utils/apiResponse";
import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service";

type MutableRequest = Request & {
  supabase?: SupabaseClient;
  user_id?: string;
  access_token?: string;
  user?: any;
  userProfile?: { name?: string };
  files?: any;
};

const tryRefreshFromCookie = async (
  req: Request,
  res: Response,
): Promise<string> => {
  if (!req.headers.cookie) return "";

  const refreshToken = authService.extractRefreshTokenCookieValue(
    req.headers.cookie,
  );
  if (!refreshToken) return "";

  try {
    const session = await authService.refreshSession(refreshToken);
    const cookies = authService.createAuthCookies(session);
    for (const cookie of cookies) {
      res.cookie(cookie.name, cookie.value, cookie.options);
    }
    return session.access_token;
  } catch (error) {
    return "";
  }
};

/**
 * Middleware to handle Supabase authentication (v2)
 * Requires valid Bearer token in Authorization header
 */
export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  let token = "";

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.headers.cookie) {
    // Fallback to cookie for cross-origin browser requests
    const cookieValue = authService.extractAuthCookieValue(req.headers.cookie);
    if (cookieValue) {
      token = authService.extractAccessTokenFromCookieValue(cookieValue) || "";
    }
    if (!token) {
      token = await tryRefreshFromCookie(req, res);
    }
  }

  if (!token) {
    return res.status(401).json({
      error: "Authentication required",
      details: "No bearer token provided",
    });
  }

  try {
    // Verify the token and get user information using v2 API
    let { data, error } = await supabase.auth.getUser(token);

    if (error) {
      const refreshedToken = await tryRefreshFromCookie(req, res);
      if (refreshedToken) {
        token = refreshedToken;
        const refreshed = await supabase.auth.getUser(token);
        data = refreshed.data;
        error = refreshed.error;
      } else {
        throw error;
      }
    }

    if (error) throw error;

    const user = data?.user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Attach user and scoped client to request
    (req as MutableRequest).user = user;

    // Create a new Supabase client for this request with the user's token
    const requestSupabase = createClient(
      SUPABASE_URL as string,
      SUPABASE_ANON_KEY as string,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    );

    // Add the authenticated client and user_id to the request object
    (req as MutableRequest).supabase = requestSupabase;
    (req as MutableRequest).user_id = user.id;
    (req as MutableRequest).access_token = token;

    next();
    } catch (error: any) {
    console.error(
      "Authentication error details:",
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    );
    return res.status(401).json({
      error: "Authentication failed",
    });
  }
};

/**
 * Optional authentication for endpoints that work both authenticated and unauthenticated
 */
export const authenticateOptional = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  // Always inject the default supabase client for public access
  (req as MutableRequest).supabase = supabase;

  let token = "";
  if (req.headers.cookie) {
    const cookieValue = authService.extractAuthCookieValue(req.headers.cookie);
    if (cookieValue) {
      token = authService.extractAccessTokenFromCookieValue(cookieValue) || "";
    }
    if (!token) {
      token = await tryRefreshFromCookie(req, res);
    }
  } else if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (token) {
    try {
      // Verify the token and get user information using v2 API
      let { data, error } = await supabase.auth.getUser(token);

      if (error) {
        const refreshedToken = await tryRefreshFromCookie(req, res);
        if (refreshedToken) {
          token = refreshedToken;
          const refreshed = await supabase.auth.getUser(token);
          data = refreshed.data;
          error = refreshed.error;
        }
      }

      if (!error && data?.user) {
        const user = data.user;

        // Create a new Supabase client for this request with the user's token
        const requestSupabase = createClient(
          SUPABASE_URL as string,
          SUPABASE_ANON_KEY as string,
          {
            global: {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          },
        );

        (req as MutableRequest).supabase = requestSupabase;
        (req as MutableRequest).user_id = user.id;
        (req as MutableRequest).access_token = token;
        (req as MutableRequest).user = user;
      }
    } catch (e: any) {
      // Optional: ignore auth errors for public/optional access
    }
  }

  next();
};

/**
 * Middleware to check if user is the manager of an event
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */

interface SupabaseRequest extends Request {
  supabase: SupabaseClient;
  user_id: string;
}

export const managerAuthMiddleware = async (
  req: SupabaseRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    // Get the entity details from the request
    const entityId =
      req.body.entityId || req.params.entityId || req.query.entityId;
    const entityType =
      req.body.entityType || req.params.entityType || req.query.entityType;
    const userId = req.user_id;

    if (!entityId || !entityType) {
      return ApiResponse.badRequest(res, "Entity ID and type are required");
    }

    // Validate entity type
    if (entityType.toLowerCase() !== "event") {
      return ApiResponse.badRequest(res, "Entity type must be 'event'");
    }

    // Check if user is the manager of the event
    const { data: entity, error: entityError } = await req.supabase
      .from("events")
      .select("owner_id")
      .eq("id", entityId)
      .single();

    if (entityError) {
      return ApiResponse.notFound(res, `${entityType} not found`);
    }

    if (!entity || (entity as any).owner_id !== userId) {
      return ApiResponse.forbidden(
        res,
        `Only the ${entityType} manager can perform this action`,
      );
    }

    next();
  } catch (error: any) {
    console.error("Manager auth middleware error:", error);
    return ApiResponse.serverError(res, error.message);
  }
};
