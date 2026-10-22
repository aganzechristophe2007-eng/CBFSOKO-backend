import { Request, Response } from "express";
import prisma from "../lib/prisma";
import { chat, listModels, SYSTEM_PROMPT } from "../services/ai.service";

const HOURLY_LIMIT = 20;
const DAILY_LIMIT = 100;
const MAX_INPUT = 2000;
const HISTORY = 12;

const getUserId = (req: Request): string => {
  const u = (req as any).user;
  return String(u?.userId ?? u?.id);
};

async function usage(userId: string) {
  const now = Date.now();
  const count = (since: number) =>
    prisma.aiMessage.count({
      where: { role: "user", createdAt: { gte: new Date(since) }, conversation: { userId } },
    });
  const [h, d] = await Promise.all([count(now - 3_600_000), count(now - 86_400_000)]);
  return { hourLeft: Math.max(0, HOURLY_LIMIT - h), dayLeft: Math.max(0, DAILY_LIMIT - d) };
}

export async function getModels(req: Request, res: Response) {
  const models = await listModels();
  res.json({ models, usage: await usage(getUserId(req)) });
}

export async function listConversations(req: Request, res: Response) {
  const items = await prisma.aiConversation.findMany({
    where: { userId: getUserId(req) },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  });
  res.json({ conversations: items });
}

export async function getConversation(req: Request, res: Response) {
  const conv = await prisma.aiConversation.findFirst({
    where: { id: String(req.params.id), userId: getUserId(req) },
    select: {
      id: true,
      model: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true },
      },
    },
  });
  if (!conv) return res.status(404).json({ error: "Conversation introuvable" });
  res.json(conv);
}

export async function deleteConversation(req: Request, res: Response) {
  const r = await prisma.aiConversation.deleteMany({
    where: { id: String(req.params.id), userId: getUserId(req) },
  });
  if (r.count === 0) return res.status(404).json({ error: "Conversation introuvable" });
  res.json({ ok: true });
}

export async function sendMessage(req: Request, res: Response) {
  const userId = getUserId(req);
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > MAX_INPUT) {
    return res.status(400).json({ error: `Message vide ou trop long (max ${MAX_INPUT} caracteres)` });
  }

  const models = await listModels();
  if (!models.length) return res.status(503).json({ error: "Aucun modele disponible" });
  const model = models.includes(req.body?.model) ? req.body.model : models[0];

  const u = await usage(userId);
  if (u.hourLeft === 0 || u.dayLeft === 0) {
    return res.status(429).json({
      error: u.hourLeft === 0 ? "Limite horaire atteinte, reessaie dans un moment" : "Limite du jour atteinte",
      usage: u,
    });
  }

  let convId: string;
  if (typeof req.body?.conversationId === "string") {
    const c = await prisma.aiConversation.findFirst({
      where: { id: req.body.conversationId, userId },
      select: { id: true },
    });
    if (!c) return res.status(404).json({ error: "Conversation introuvable" });
    convId = c.id;
  } else {
    const c = await prisma.aiConversation.create({
      data: { userId, model, title: message.slice(0, 60) },
    });
    convId = c.id;
  }

  const past = await prisma.aiMessage.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: "desc" },
    take: HISTORY,
    select: { role: true, content: true },
  });
  past.reverse();

  await prisma.aiMessage.create({ data: { conversationId: convId, role: "user", content: message } });

  try {
    const answer = await chat(model, [
      { role: "system", content: SYSTEM_PROMPT },
      ...past,
      { role: "user", content: message },
    ]);
    const saved = await prisma.aiMessage.create({
      data: { conversationId: convId, role: "assistant", content: answer },
      select: { id: true, role: true, content: true },
    });
    await prisma.aiConversation.update({ where: { id: convId }, data: { model } });
    return res.json({ conversationId: convId, message: saved, usage: await usage(userId) });
  } catch {
    return res.status(502).json({
      error: "A30 IA est indisponible pour le moment",
      conversationId: convId,
    });
  }
}
