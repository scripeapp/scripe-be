import { NextFunction, Response } from "express";
import { AdminRole, AdminService, AdminUser } from "../services/admin.service";
import { SupabaseRequest } from "../types/http";
import { supabaseAdmin } from "../config/supabase";
import { cacheGet, cacheSet } from "../config/redis";

const ADMIN_USER_TTL = 300; // 5 minutes

/**
 * Middleware to check if the authenticated user is a Hilaq Admin.
 * Should be used AFTER authenticateUser middleware.
 */
export const requireAdmin = (minRole: AdminRole = 'viewer') => {
  return async (req: SupabaseRequest, res: Response, next: NextFunction) => {
    if (!req.supabase || !req.user_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const client = supabaseAdmin || req.supabase;
      const adminService = new AdminService(client);

      const cacheKey = `admin_user:${req.user_id}`;
      let adminUser = await cacheGet<AdminUser>(cacheKey);
      if (!adminUser) {
        adminUser = await adminService.getAdminUser(req.user_id);
        if (adminUser) {
          await cacheSet(cacheKey, adminUser, ADMIN_USER_TTL);
        }
      }
      
      if (!adminUser) {
        console.warn(`[AdminCheck] Access Denied: User ${req.user_id} is not in admin_users table or is inactive.`);
        return res.status(403).json({ error: "Admin access required" });
      }

      console.log(`[AdminCheck] Admin found: ${adminUser.name} (${adminUser.role})`);

      // Check role hierarchy
      if (!adminService.hasRole(adminUser.role, minRole)) {
        console.warn(`[AdminCheck] Insufficient Role: Found ${adminUser.role}, required ${minRole}`);
        return res.status(403).json({ error: "Insufficient admin privileges" });
      }
      
      // Attach admin data to request for controller use
      req.admin = adminUser;
      
      next();
    } catch (error) {
      console.error("Admin authorization error:", error);
      res.status(500).json({ error: "Internal server error during admin validation" });
    }
  };
};


/**
 * Middleware to check for a specific granular permission.
 * Super admins bypass this check.
 */
export const requireAdminPermission = (permission: string) => {
  return async (req: SupabaseRequest, res: Response, next: NextFunction) => {
    if (!req.supabase || !req.user_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const client = supabaseAdmin || req.supabase;
      const adminService = new AdminService(client);
      
      // If admin data is already on req (from requireAdmin), use it. otherwise fetch.
      let adminUser = req.admin;
      if (!adminUser) {
        adminUser = (await adminService.getAdminUser(req.user_id)) || undefined;
      }

      if (!adminUser) {
        return res.status(403).json({ error: "Admin access required" });
      }

      if (!adminService.hasPermission(adminUser, permission)) {
        return res.status(403).json({ 
          error: `Insufficient permissions. Required: ${permission}` 
        });
      }

      req.admin = adminUser;
      next();
    } catch (error) {
      console.error("Admin permission error:", error);
      res.status(500).json({ error: "Internal server error during admin validation" });
    }
  };
};
