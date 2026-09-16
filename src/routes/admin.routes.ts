import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requireAdmin } from "../middleware/admin.middleware";
import { adminController } from "../controllers/admin.controller";
import { withSupabase } from "../types/http";

const router = Router();

/**
 * All routes in this file are protected by general admin verification.
 * More granular permission checks can be added at the route level.
 */

// Basic Platform Stats
router.get(
  "/stats",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getStats.bind(adminController)),
);

// Audit Logs
router.get(
  "/audit-logs",
  authenticateUser,
  requireAdmin("support") as any, // Tightened from moderator
  withSupabase(adminController.getAuditLogs.bind(adminController)),
);

// User Management
router.get(
  "/users",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listUsers.bind(adminController)),
);

router.get(
  "/users/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getUserDetails.bind(adminController)),
);

router.post(
  "/users/warn",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.warnUser.bind(adminController)),
);

router.post(
  "/users/:id/impersonate",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.impersonateUser.bind(adminController)),
);

// Business Management
router.get(
  "/businesses",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listBusinesses.bind(adminController)),
);

router.get(
  "/businesses/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getBusinessDetails.bind(adminController)),
);

// Store Management
router.get(
  "/stores",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listStores.bind(adminController)),
);

router.get(
  "/stores/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getStoreDetails.bind(adminController)),
);

router.get(
  "/publications",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listPublications.bind(adminController)),
);

// Course Management (platform monitoring)
router.get(
  "/courses",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.listCourses.bind(adminController)),
);

// Financial Operations
router.get(
  "/payouts",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.listPayouts.bind(adminController)),
);

router.get(
  "/transactions",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.listTransactions.bind(adminController)),
);

// Content Moderation
router.get(
  "/moderation/queue",
  authenticateUser,
  requireAdmin("moderator") as any,
  withSupabase(adminController.getModerationQueue.bind(adminController)),
);

router.post(
  "/moderation/:id/review",
  authenticateUser,
  requireAdmin("moderator") as any,
  withSupabase(adminController.reviewContent.bind(adminController)),
);

// System Configuration
router.get(
  "/config/feature-flags",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.getFeatureFlags.bind(adminController)),
);

router.post(
  "/config",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.updateConfig.bind(adminController)),
);

// Subscription Plan Management
router.get(
  "/plans",
  authenticateUser,
  requireAdmin("super_admin") as any, // Only super admins can manage plans
  withSupabase(adminController.listPlans.bind(adminController)),
);

router.get(
  "/plans/stats",
  authenticateUser,
  requireAdmin("support") as any, // Support can see plan stats
  withSupabase(adminController.getPlanStats.bind(adminController)),
);

router.get(
  "/plans/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.getPlan.bind(adminController)),
);

router.post(
  "/plans",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.savePlan.bind(adminController)),
);

router.put(
  "/plans/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.savePlan.bind(adminController)),
);

router.delete(
  "/plans/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.deletePlan.bind(adminController)),
);

router.post(
  "/plans/cache/clear",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.clearPlanCache.bind(adminController)),
);

// Admin User Management
router.get(
  "/admins",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.listAdmins.bind(adminController)),
);

router.post(
  "/admins",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.saveAdmin.bind(adminController)),
);

// Manual Business Subscription Upgrades
router.post(
  "/businesses/upgrade-subscription",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(
    adminController.upgradeBusinessSubscription.bind(adminController),
  ),
);

// Business Category Management
router.get(
  "/categories",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listCategories.bind(adminController)),
);

router.get(
  "/categories/stats",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getCategoryStats.bind(adminController)),
);

router.get(
  "/categories/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getCategory.bind(adminController)),
);

router.post(
  "/categories",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.createCategory.bind(adminController)),
);

router.put(
  "/categories/reorder",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.reorderCategories.bind(adminController)),
);

router.put(
  "/categories/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.updateCategory.bind(adminController)),
);

router.delete(
  "/categories/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.deleteCategory.bind(adminController)),
);

// ============================================================
// PHASE 1: Analytics — MRR / ARR / Churn
// ============================================================
router.get(
  "/analytics/overview",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getAnalyticsOverview.bind(adminController)),
);

// ============================================================
// PHASE 1: Finance — P&L Dashboard
// ============================================================
router.get(
  "/finance/overview",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getFinanceOverview.bind(adminController)),
);

router.get(
  "/finance/timeseries",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getFinanceTimeSeries.bind(adminController)),
);

router.get(
  "/finance/top-businesses",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getTopRevenueBusinesses.bind(adminController)),
);

// ============================================================
// PHASE 1: Dunning Management
// ============================================================
router.get(
  "/dunning",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getDunningCases.bind(adminController)),
);

router.post(
  "/dunning/process-retries",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.processDunningRetries.bind(adminController)),
);

// ============================================================
// PHASE 1: Upgrade Signals
// ============================================================
router.get(
  "/upgrade-signals/summary",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getUpgradeSignalsSummary.bind(adminController)),
);

router.get(
  "/upgrade-signals",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getUpgradeSignals.bind(adminController)),
);

// ============================================================
// PHASE 2: Admin User Management
// ============================================================
router.patch(
  "/admins/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.updateAdmin.bind(adminController)),
);

router.delete(
  "/admins/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.deactivateAdmin.bind(adminController)),
);

// ============================================================
// PHASE 2: Bulk Operations
// ============================================================
router.post(
  "/bulk/users",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.bulkUserAction.bind(adminController)),
);

router.post(
  "/bulk/businesses",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.bulkBusinessAction.bind(adminController)),
);

// ============================================================
// PHASE 2: Admin Alerts
// ============================================================
router.get(
  "/alerts/unread-count",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getAlertUnreadCount.bind(adminController)),
);

router.get(
  "/alerts",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getAlerts.bind(adminController)),
);

router.patch(
  "/alerts/read",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.markAlertsRead.bind(adminController)),
);

// ============================================================
// PHASE 2: Webhook Logs
// ============================================================
router.get(
  "/webhook-logs/stats",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getWebhookStats.bind(adminController)),
);

router.get(
  "/webhook-logs",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getWebhookLogs.bind(adminController)),
);

// ============================================================
// PHASE 2: System Announcements
// ============================================================
router.get(
  "/announcements",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listAnnouncements.bind(adminController)),
);

router.post(
  "/announcements",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.createAnnouncement.bind(adminController)),
);

router.patch(
  "/announcements/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.updateAnnouncement.bind(adminController)),
);

router.delete(
  "/announcements/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.deleteAnnouncement.bind(adminController)),
);

// ============================================================
// PHASE 3: Refunds & Disputes
// ============================================================
router.get(
  "/refunds/stats",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getRefundStats.bind(adminController)),
);

router.get(
  "/refunds",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listRefunds.bind(adminController)),
);

router.post(
  "/refunds",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.createRefund.bind(adminController)),
);

router.post(
  "/refunds/:id/review",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.reviewRefund.bind(adminController)),
);

router.get(
  "/disputes",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listDisputes.bind(adminController)),
);

router.post(
  "/disputes/:id/resolve",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.resolveDispute.bind(adminController)),
);

// ============================================================
// PHASE 3: KYC Verification
// ============================================================
router.get(
  "/kyc/stats",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getKYCStats.bind(adminController)),
);

router.get(
  "/kyc",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listKYC.bind(adminController)),
);

router.post(
  "/kyc/:id/review",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.reviewKYC.bind(adminController)),
);

// ============================================================
// PHASE 3: Fraud Detection
// ============================================================
router.get(
  "/fraud/stats",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getFraudStats.bind(adminController)),
);

router.get(
  "/fraud/signals",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listFraudSignals.bind(adminController)),
);

router.patch(
  "/fraud/signals/:id/review",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.reviewFraudSignal.bind(adminController)),
);

// ============================================================
// PHASE 3: NDPR Compliance
// ============================================================
router.get(
  "/ndpr/stats",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getNDPRStats.bind(adminController)),
);

router.get(
  "/ndpr",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listNDPRRequests.bind(adminController)),
);

router.patch(
  "/ndpr/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.updateNDPRRequest.bind(adminController)),
);

router.post(
  "/ndpr/:id/export",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.generateNDPRExport.bind(adminController)),
);

// ============================================================
// PHASE 4: Customer Health Score
// ============================================================
router.get(
  "/health/summary",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getHealthSummary.bind(adminController)),
);

router.get(
  "/health/overview",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getHealthOverview.bind(adminController)),
);

router.get(
  "/health/:businessId",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getBusinessHealth.bind(adminController)),
);

// ============================================================
// PHASE 4: Helpdesk
// ============================================================
router.get(
  "/helpdesk/stats",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getHelpdeskStats.bind(adminController)),
);

router.get(
  "/helpdesk/tickets",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.listTickets.bind(adminController)),
);

router.get(
  "/helpdesk/tickets/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.getTicket.bind(adminController)),
);

router.patch(
  "/helpdesk/tickets/:id",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.updateTicket.bind(adminController)),
);

router.post(
  "/helpdesk/tickets/:id/reply",
  authenticateUser,
  requireAdmin("support") as any,
  withSupabase(adminController.replyToTicket.bind(adminController)),
);

// ============================================================
// PHASE 4: NPS
// ============================================================
router.get(
  "/nps/summary",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getNPSSummary.bind(adminController)),
);

router.get(
  "/nps/responses",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.listNPSResponses.bind(adminController)),
);

router.get(
  "/nps/feedback",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getNPSFeedback.bind(adminController)),
);

// ============================================================
// AI Agent (Command Center panel) settings
// ============================================================
router.get(
  "/ai-agent-settings",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getAiAgentSettings.bind(adminController)),
);

router.put(
  "/ai-agent-settings",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.updateAiAgentSettings.bind(adminController)),
);

// Read-only introspection of what the agent can actually do — sourced live
// from the registered tools, not hand-maintained copy.
router.get(
  "/ai-agent-capabilities",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getAiAgentCapabilities.bind(adminController)),
);

// ============================================================
// PHASE 4: Feature Flags
// ============================================================
router.get(
  "/feature-flags",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.listFeatureFlags.bind(adminController)),
);

router.post(
  "/feature-flags",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.createFeatureFlag.bind(adminController)),
);

router.patch(
  "/feature-flags/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.updateFeatureFlag.bind(adminController)),
);

router.delete(
  "/feature-flags/:id",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.deleteFeatureFlag.bind(adminController)),
);

// ============================================================
// PHASE 5: Revenue Forecast
// ============================================================
router.get(
  "/forecast",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getRevenueForecast.bind(adminController)),
);

// ============================================================
// Payout Requests (read-only tracking)
// ============================================================
router.get(
  "/payout-requests",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.listPayoutRequests.bind(adminController)),
);

// ============================================================
// PHASE 5: Leaderboards
// ============================================================
router.get(
  "/leaderboards/revenue",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getRevenueLeaderboard.bind(adminController)),
);

router.get(
  "/leaderboards/orders",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getOrdersLeaderboard.bind(adminController)),
);

router.get(
  "/leaderboards/active",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getMostActiveBusinesses.bind(adminController)),
);

router.get(
  "/leaderboards/newest-paid",
  authenticateUser,
  requireAdmin("viewer") as any,
  withSupabase(adminController.getNewestPaidBusinesses.bind(adminController)),
);

// ============================================================
// ADM-001: Marketplace Suppression
// ============================================================
router.get(
  "/marketplace/items",
  authenticateUser,
  requireAdmin("moderator") as any,
  withSupabase(adminController.listMarketplaceItems.bind(adminController)),
);

router.get(
  "/marketplace/suppressed",
  authenticateUser,
  requireAdmin("moderator") as any,
  withSupabase(adminController.listSuppressedItems.bind(adminController)),
);

router.patch(
  "/marketplace/suppress",
  authenticateUser,
  requireAdmin("moderator") as any,
  withSupabase(adminController.suppressMarketplaceItem.bind(adminController)),
);

router.patch(
  "/marketplace/suppress/business/:businessId",
  authenticateUser,
  requireAdmin("moderator") as any,
  withSupabase(
    adminController.bulkSuppressBusinessItems.bind(adminController),
  ),
);

// ============================================================
// Cron Job Management
// ============================================================
router.get(
  "/crons",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.listCronJobs.bind(adminController)),
);

router.post(
  "/crons/:jobId/run",
  authenticateUser,
  requireAdmin("super_admin") as any,
  withSupabase(adminController.runCronJob.bind(adminController)),
);

// ============================================================
// Payment Recovery
// ============================================================

// Static route must come before /payments/:reference to avoid being swallowed
router.get(
  "/payments/recovery-queue",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.listRecoveryQueue.bind(adminController)),
);

// Transfer (withdrawal) recovery — distinct `/payments/transfer/...` namespace so
// it never conflicts with checkout payment or deposit lookup.
router.get(
  "/payments/transfer/:reference",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.lookupTransfer.bind(adminController)),
);

router.post(
  "/payments/transfer/:reference/finalize",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.finalizeTransfer.bind(adminController)),
);

router.post(
  "/payments/transfer/:reference/sync",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.syncTransfer.bind(adminController)),
);

router.get(
  "/payments/:reference",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.lookupPayment.bind(adminController)),
);

router.post(
  "/payments/:reference/fulfill",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.fulfillPayment.bind(adminController)),
);

// Admin-guided fulfillment for any verified provider payment: pick the event
// and tickets, then issue the order through the standard fulfillment pipeline.
router.post(
  "/payments/:reference/fulfill-event",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.fulfillEventOrder.bind(adminController)),
);

router.get(
  "/events/:eventId/tickets",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.getEventTickets.bind(adminController)),
);

router.post(
  "/payments/:reference/recover-event-fulfillment",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.recoverEventFulfillment.bind(adminController)),
);

router.post(
  "/payments/:reference/resend-emails",
  authenticateUser,
  requireAdmin("finance") as any,
  withSupabase(adminController.resendOrderEmails.bind(adminController)),
);

export default router;
