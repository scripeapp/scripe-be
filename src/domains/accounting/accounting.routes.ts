import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { AccountingController } from "./accounting.controller.js";
import { AccountingService } from "./accounting.service.js";

export function createAccountingRouter(): Router {
  const router = Router();
  const controller = new AccountingController(new AccountingService(getDatabase()));
  const base = "/api/businesses/:businessId/accounting";

  router.use(base, requireAuth);
  router.get(`${base}/ledger-accounts`, controller.listLedgerAccounts);
  router.get(`${base}/journal-entries`, controller.listJournalEntries);
  router.get(`${base}/journal-entries/:journalEntryId`, controller.getJournalEntry);
  router.get(`${base}/trial-balance`, controller.getTrialBalance);
  router.get(`${base}/periods`, controller.listPeriods);
  router.patch(`${base}/periods/:periodId`, controller.setPeriodStatus);

  return router;
}
