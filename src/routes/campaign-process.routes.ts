import { Router } from "express";
import campaignProcessController from "../controllers/campaign-process.controller";

const router = Router();

router.post(
  "/process",
  campaignProcessController.process.bind(campaignProcessController)
);

router.post(
  "/process/failure",
  campaignProcessController.failure.bind(campaignProcessController)
);

export default router;
