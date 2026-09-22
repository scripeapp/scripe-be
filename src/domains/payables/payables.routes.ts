/**
 * Express route composition for the bill, bill line, and bill payment allocation domain
 * belongs here. Routes are registered only after the capability and contract are
 * approved.
 */
import { Router } from "express"; import { getDatabase } from "../../db/database.js"; import { requireAuth } from "../../middleware/auth.js"; import { ApprovalsService } from "../approvals/approvals.service.js"; import { PayablesController } from "./payables.controller.js"; import { PayablesService } from "./payables.service.js";
export function createPayablesRouter(): Router { const router = Router(); const controller = new PayablesController(new PayablesService(getDatabase(), new ApprovalsService(getDatabase()))); const base = "/api/businesses/:businessId/payables"; router.use(base, requireAuth); router.post(`${base}/bills`, controller.createBill); router.post(`${base}/bills/:billId/payments`, controller.allocatePayment); return router; }
