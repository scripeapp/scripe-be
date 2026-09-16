import { Router } from "express";
import { TeamController } from "../controllers/team.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission, requireAnyPermission } from "../middleware/authorize.middleware";

const router = Router();

// Apply authentication to all routes
router.use(authenticateUser);

// ============================================================================
// PERMISSIONS (System-wide, read-only)
// ============================================================================

// GET /permissions - List all system permissions
router.get("/permissions", TeamController.getAllPermissions);

// GET /permissions/grouped - List permissions grouped by category
router.get("/permissions/grouped", TeamController.getPermissionsByCategory);

// ============================================================================
// INVITATION ACCEPTANCE (No business context needed - token is self-contained)
// ============================================================================

// POST /invites/:token/accept - Accept an invitation
router.post("/invites/:token/accept", TeamController.acceptInvitation);

// ============================================================================
// BUSINESS-SCOPED ROUTES
// ============================================================================

// Members
router.get(
  "/businesses/:businessId/members",
  requirePermission("team.member.read"),
  TeamController.getMembers
);

// Unified roster: memberships merged with pos_staff (POS till access),
// including PIN-only staff who have no dashboard membership — see
// TeamService.getTeamRoster.
router.get(
  "/businesses/:businessId/roster",
  requirePermission("team.member.read"),
  TeamController.getTeamRoster
);

router.get(
  "/businesses/:businessId/me",
  TeamController.getMyMembership
);

router.patch(
  "/businesses/:businessId/members/:memberId/role",
  requirePermission("team.member.update_role"),
  TeamController.updateMemberRole
);

router.delete(
  "/businesses/:businessId/members/:memberId",
  requirePermission("team.member.remove"),
  TeamController.removeMember
);

// Invitations
router.get(
  "/businesses/:businessId/invites",
  requirePermission("team.member.read"),
  TeamController.getPendingInvitations
);

router.post(
  "/businesses/:businessId/invites",
  requirePermission("team.member.invite"),
  TeamController.sendInvitation
);

router.delete(
  "/businesses/:businessId/invites/:invitationId",
  requirePermission("team.member.invite"),
  TeamController.revokeInvitation
);

// Roles
router.get(
  "/businesses/:businessId/roles",
  requirePermission("team.role.read"),
  TeamController.getRoles
);

router.get(
  "/roles/:roleId",
  TeamController.getRoleWithPermissions
);

router.get(
  "/roles/:roleId/permissions",
  TeamController.getRoleWithPermissions
);

router.post(
  "/businesses/:businessId/roles",
  requirePermission("team.role.create"),
  TeamController.createRole
);

router.patch(
  "/roles/:roleId",
  requirePermission("team.role.update"),
  TeamController.updateRole
);

router.put(
  "/roles/:roleId/permissions",
  requirePermission("team.role.update"),
  TeamController.updateRole
);

router.delete(
  "/roles/:roleId",
  requirePermission("team.role.delete"),
  TeamController.deleteRole
);

export const teamRoutes = router;
