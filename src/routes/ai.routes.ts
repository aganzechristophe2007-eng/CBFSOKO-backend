import { Router } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/auth.middleware";
import {
  getModels,
  listConversations,
  getConversation,
  deleteConversation,
  sendMessage,
} from "../controllers/ai.controller";

const router = Router();

router.use(express.json({ limit: "20kb" }));
router.use(rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false }));
router.use(requireAuth);

router.get("/models", getModels);
router.get("/conversations", listConversations);
router.get("/conversations/:id", getConversation);
router.delete("/conversations/:id", deleteConversation);
router.post("/chat", sendMessage);

export default router;
