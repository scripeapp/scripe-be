import { Router } from "express";
import { getDatabaseGateway } from "../db/database.js";

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/health/live", (_request, response) => {
    response.json({ status: "ok" });
  });

  router.get("/health/ready", async (_request, response) => {
    const gateway = getDatabaseGateway();
    let databaseUp = false;
    try {
      databaseUp = await gateway.checkReachability();
    } catch {
      databaseUp = false;
    }

    if (!databaseUp) {
      response.status(503).json({
        status: "down",
        checks: { database: "down" as const },
      });
      return;
    }

    response.status(200).json({
      status: "ok",
      checks: { database: "up" as const },
    });
  });

  return router;
}
