import { Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { TeamService } from "../services/team.service";
import { PermissionService } from "../services/permission.service";

interface AuthenticatedRequest extends Request {
  user_id?: string; // Auth middleware sets this
  supabase?: SupabaseClient;
  businessId?: string;
}

export class TeamController {
  // ============================================================================
  // MEMBERS
  // ============================================================================

  static async getMembers(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const service = new TeamService(db);
      const members = await service.getMembers(businessId);
      return res.json({ success: true, data: members });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch members",
      });
    }
  }

  static async getTeamRoster(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const service = new TeamService(db);
      const roster = await service.getTeamRoster(businessId);
      return res.json({ success: true, data: roster });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch team roster",
      });
    }
  }

  static async getMyMembership(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const service = new TeamService(db);
      const membership = await service.getMyMembership(
        req.user_id!,
        businessId,
      );
      return res.json({ success: true, data: membership });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch membership",
      });
    }
  }

  static async updateMemberRole(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const { memberId } = req.params;
      const { role_id } = req.body;
      const service = new TeamService(db);
      const result = await service.updateMemberRole(
        businessId,
        memberId,
        role_id,
        req.user_id!,
      );
      return res.json({ success: true, data: result });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to update member role",
      });
    }
  }

  static async removeMember(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const { memberId } = req.params;
      const service = new TeamService(db);
      await service.removeMember(businessId, memberId, req.user_id!);
      return res.json({
        success: true,
        message: "Member removed successfully",
      });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to remove member",
      });
    }
  }

  // ============================================================================
  // INVITATIONS
  // ============================================================================

  static async sendInvitation(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const { email, emails, role_id } = req.body;
      const service = new TeamService(db);

      // Normalize to array of emails
      const emailList: string[] = emails || (email ? [email] : []);

      if (emailList.length === 0) {
        return res.status(400).json({
          success: false,
          error: "At least one email address is required",
        });
      }

      // Process invitations for all emails
      const results: {
        email: string;
        success: boolean;
        error?: string;
        data?: any;
      }[] = [];

      for (const emailAddr of emailList) {
        try {
          const result = await service.sendInvitation(
            businessId,
            emailAddr,
            role_id,
            req.user_id!,
          );
          results.push({ email: emailAddr, success: true, data: result });
        } catch (error: any) {
          results.push({
            email: emailAddr,
            success: false,
            error: error.message || "Failed to send invitation",
          });
        }
      }

      // Determine overall response
      const allSuccessful = results.every((r) => r.success);
      const allFailed = results.every((r) => !r.success);

      if (allFailed) {
        return res.status(400).json({
          success: false,
          error: "Failed to send all invitations",
          results,
        });
      }

      return res.status(201).json({
        success: true,
        message: allSuccessful
          ? `Successfully sent ${results.length} invitation(s)`
          : `Sent ${results.filter((r) => r.success).length} of ${results.length} invitations`,
        results,
      });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to send invitation",
      });
    }
  }

  static async acceptInvitation(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { token } = req.params;
      const service = new TeamService(db);
      const result = await service.acceptInvitation(token, req.user_id!);
      return res.json({ success: true, data: result });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to accept invitation",
      });
    }
  }

  static async getPendingInvitations(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const service = new TeamService(db);
      const invitations = await service.getPendingInvitations(businessId);
      return res.json({ success: true, data: invitations });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch invitations",
      });
    }
  }

  static async revokeInvitation(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const { invitationId } = req.params;
      const service = new TeamService(db);
      await service.revokeInvitation(businessId, invitationId, req.user_id!);
      return res.json({ success: true, message: "Invitation revoked" });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to revoke invitation",
      });
    }
  }

  // ============================================================================
  // ROLES
  // ============================================================================

  static async getRoles(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const service = new TeamService(db);
      const roles = await service.getRoles(businessId);
      return res.json({ success: true, data: roles });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch roles",
      });
    }
  }

  static async getRoleWithPermissions(
    req: AuthenticatedRequest,
    res: Response,
  ) {
    try {
      const db = req.supabase!;
      const { roleId } = req.params;
      const service = new TeamService(db);
      const role = await service.getRoleWithPermissions(roleId);
      return res.json({ success: true, data: role });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch role",
      });
    }
  }

  static async createRole(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const businessId = req.params.businessId || req.businessId!;
      const { name, permission_ids } = req.body;
      const service = new TeamService(db);
      const role = await service.createRole(
        businessId,
        name,
        permission_ids || [],
        req.user_id!,
      );
      return res.status(201).json({ success: true, data: role });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to create role",
      });
    }
  }

  static async updateRole(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { roleId } = req.params;
      const { name, permission_ids } = req.body;
      const service = new TeamService(db);
      const role = await service.updateRole(
        roleId,
        { name, permissionIds: permission_ids },
        req.user_id!,
      );
      return res.json({ success: true, data: role });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to update role",
      });
    }
  }

  static async deleteRole(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { roleId } = req.params;
      const service = new TeamService(db);
      await service.deleteRole(roleId, req.user_id!);
      return res.json({ success: true, message: "Role deleted successfully" });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to delete role",
      });
    }
  }

  // ============================================================================
  // PERMISSIONS
  // ============================================================================

  static async getAllPermissions(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const service = new PermissionService(db);
      const permissions = await service.getAllPermissions();
      return res.json({ success: true, data: permissions });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch permissions",
      });
    }
  }

  static async getPermissionsByCategory(
    req: AuthenticatedRequest,
    res: Response,
  ) {
    try {
      const db = req.supabase!;
      const service = new PermissionService(db);
      const permissions = await service.getPermissionsByCategory();
      return res.json({ success: true, data: permissions });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch permissions",
      });
    }
  }
}
