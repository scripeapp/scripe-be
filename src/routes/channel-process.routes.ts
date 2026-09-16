import { Router } from "express";
import channelProcessController from "../controllers/channel-process.controller";

const router = Router();

router.post("/process", channelProcessController.process.bind(channelProcessController));
router.post(
  "/process/failure",
  channelProcessController.failure.bind(channelProcessController),
);

export default router;
