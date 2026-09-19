import { Router } from "express";
import { getDatabaseGateway } from "../db/database.js";
import { ApiResponse } from "../shared/api-response.js";

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/health/live", (_request, response) => {
    ApiResponse.success(response, { status: "ok" as const });
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
      ApiResponse.error(
        response,
        {
          code: "SERVICE_UNAVAILABLE",
          message: "Service is not ready",
          details: {
            status: "down",
            checks: { database: "down" as const },
          },
        },
        503,
      );
      return;
    }

    ApiResponse.success(response, {
      status: "ok",
      checks: { database: "up" as const },
    });
  });

  return router;
}
