import { Request, Response, NextFunction } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { PermissionService } from "../services/permission.service";
import { StoreService } from "../services/store.service";
import { supabaseAdmin } from "../config/supabase";
import { authenticateUser } from "./supabase-auth-middleware";

interface AuthenticatedRequest extends Request {
  user_id?: string; // Auth middleware sets this
  supabase?: SupabaseClient;
  businessId?: string; // Resolved business context
  deviceRegister?: { id: string; store_id: string; branch_id: string | null };
}

/**
 * Resolve business ID from request
 * Checks params, body, query, and can resolve from store_id
 */
export async function resolveBusinessId(
  req: AuthenticatedRequest,
): Promise<string | null> {
  // Direct business ID
  // Check common variations: businessId, business_id, and generic id
  const businessId =
    req.params.businessId ||
    req.body.business_id ||
    req.body.businessId ||
    req.query.business_id ||
    req.query.businessId;

  if (businessId) {
    return businessId as string;
  }

  const db = req.supabase;
  if (!db) return null;
  const permissionService = new PermissionService(db);

  // Resolve from store ID (Common case)
  const storeId =
    req.params.storeId ||
    req.body.store_id ||
    req.body.storeId ||
    req.query.store_id ||
    req.query.storeId;
  if (storeId) {
    return await permissionService.getBusinessIdFromStore(storeId as string);
  }

  // Resolve from product ID (Common case)
  const productId =
    req.params.productId ||
    req.body.product_id ||
    req.body.productId ||
    req.query.product_id ||
    req.query.productId;
  if (productId) {
    return await permissionService.getBusinessIdFromProduct(
      productId as string,
    );
  }

  return null;
}

/**
 * Middleware: Require a specific permission
 * @param permissionKey Permission key in dot-notation (e.g., 'store.product.create')
 */
export function requirePermission(permissionKey: string) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user_id;
      const db = req.supabase;

      if (!userId || !db) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const businessId = await resolveBusinessId(req);
      if (!businessId) {
        return res
          .status(400)
          .json({ success: false, error: "Business context required" });
      }

      // Store resolved business ID on request for downstream use
      req.businessId = businessId;

      // Use request-scoped client to respect RLS
      const permissionService = new PermissionService(db);
      const hasPermission = await permissionService.hasPermission(
        userId,
        businessId,
        permissionKey,
      );

      if (!hasPermission) {
        return res.status(403).json({
          success: false,
          error: `Access denied: Missing permission '${permissionKey}'`,
        });
      }

      return next();
    } catch (error: any) {
      console.error("[Authorization] Error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Authorization error" });
    }
  };
}

/**
 * Middleware: Require ANY of the specified permissions (OR logic)
 * @param permissionKeys Array of permission keys
 */
export function requireAnyPermission(permissionKeys: string[]) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user_id;
      const db = req.supabase;

      if (!userId || !db) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const businessId = await resolveBusinessId(req);
      if (!businessId) {
        return res
          .status(400)
          .json({ success: false, error: "Business context required" });
      }

      req.businessId = businessId;

      const permissionService = new PermissionService(db);
      const hasAny = await permissionService.hasAnyPermission(
        userId,
        businessId,
        permissionKeys,
      );

      if (!hasAny) {
        return res.status(403).json({
          success: false,
          error: `Access denied: Requires one of [${permissionKeys.join(", ")}]`,
        });
      }

      return next();
    } catch (error: any) {
      console.error("[Authorization] Error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Authorization error" });
    }
  };
}

/**
 * Middleware: Require a specific role
 * @param roleName Role name (e.g., 'Admin', 'Owner')
 */
export function requireRole(roleName: string) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userId = req.user_id;
      const db = req.supabase;

      if (!userId || !db) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const businessId = await resolveBusinessId(req);
      if (!businessId) {
        return res
          .status(400)
          .json({ success: false, error: "Business context required" });
      }

      req.businessId = businessId;

      const permissionService = new PermissionService(db);
      const hasRole = await permissionService.hasRole(
        userId,
        businessId,
        roleName,
      );

      if (!hasRole) {
        return res.status(403).json({
          success: false,
          error: `Access denied: Requires role '${roleName}'`,
        });
      }

      return next();
    } catch (error: any) {
      console.error("[Authorization] Error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Authorization error" });
    }
  };
}


/**
 * Middleware: require a paired POS device's bearer token — no dashboard
 * session fallback. Used for endpoints only a device would ever call
 * (e.g. GET /pos/session).
 */
export function requireRegisterDevice() {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const deviceToken = req.headers["x-register-device-token"] as
      | string
      | undefined;
    if (!deviceToken) {
      return res.status(401).json({
        success: false,
        error: "Register device token required",
      });
    }

    try {
      const service = new StoreService(supabaseAdmin);
      const register = await service.getRegisterByDeviceToken(deviceToken);
      if (!register) {
        return res.status(401).json({
          success: false,
          error: "Invalid or revoked device pairing",
        });
      }
      req.supabase = supabaseAdmin;
      req.deviceRegister = {
        id: register.id,
        store_id: register.store_id,
        branch_id: register.branch_id,
      };
      return next();
    } catch (error: any) {
      console.error("[Authorization] Device auth error:", error);
      return res
        .status(500)
        .json({ success: false, error: "Authorization error" });
    }
  };
}
