import { Router } from "express";
import { createSubscriptionHandler, listSubscriptionsHandler, legacyReplayHandler } from "./webhooks/handlers";
import { recordEventHandler } from "./events/handlers";

export const router = Router();

router.post("/webhooks", createSubscriptionHandler);
router.get("/webhooks", listSubscriptionsHandler);
router.post("/webhooks/legacy-replay", legacyReplayHandler);
router.post("/events", recordEventHandler);
