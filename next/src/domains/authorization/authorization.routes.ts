import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { AuthorizationController } from "./authorization.controller.js";
import { AuthorizationService } from "./authorization.service.js";

export function createAuthorizationRouter(): Router {
  const router = Router();
  const controller = new AuthorizationController(new AuthorizationService(getDatabase()));
  const base = "/api/businesses/:businessId/team";

  router.get("/api/permissions", requireAuth, controller.listPermissions);
  router.post("/api/invitations/:token/accept", requireAuth, controller.acceptInvitation);

  router.use(base, requireAuth);

  router.get(`${base}/members`, controller.listMembers);
  router.get(`${base}/me`, controller.getMyMembership);
  router.patch(`${base}/members/:membershipId/roles`, controller.setMemberRoles);
  router.delete(`${base}/members/:membershipId`, controller.removeMember);

  router.get(`${base}/invitations`, controller.listPendingInvitations);
  router.post(`${base}/invitations`, controller.inviteMembers);
  router.delete(`${base}/invitations/:invitationId`, controller.revokeInvitation);

  router.get(`${base}/roles`, controller.listRoles);
  router.post(`${base}/roles`, controller.createRole);
  router.get(`${base}/roles/:roleId`, controller.getRole);
  router.patch(`${base}/roles/:roleId`, controller.updateRole);
  router.delete(`${base}/roles/:roleId`, controller.deleteRole);

  return router;
}
