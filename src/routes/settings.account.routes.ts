import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';

// ==========================================
// PARAMÈTRES DU COMPTE — lot 1 et 2
//  PATCH /api/settings/profile    : nom et téléphone
//  POST  /api/settings/password   : changement de mot de passe
//  GET   /api/settings/dashboard  : évolution personnelle (vues, ventes, revenus, achats)
// Les routes existantes (/avatar, /products...) restent dans server.ts, inchangées.
// ==========================================

const router = Router();

const userKey = (req: unknown): string => (req as AuthRequest).user?.id ?? 'anonyme';

const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { success: false, error: 'Trop de modifications. Réessayez dans quelques minutes.' },
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { success: false, error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
});

const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ success: false, error, message: error });

// ---------- Profil ----------
const profileSchema = z.object({
  name: z.string().trim().min(2, 'Le nom doit contenir au moins 2 caractères.').max(60, 'Le nom est trop long (60 caractères maximum).'),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'Numéro de téléphone invalide.')
    .or(z.literal(''))
    .optional(),
});

router.patch('/profile', requireAuth, profileLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Données invalides.');

    const { name, phone } = parsed.data;
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { name, ...(phone !== undefined ? { phone: phone === '' ? null : phone } : {}) },
    });

    const { password: _pw, ...safeUser } = user;
    return res.json({ success: true, user: safeUser });
  } catch (err: unknown) {
    console.error('Erreur PATCH /settings/profile :', err instanceof Error ? err.message : err);
    return fail(res, 500, 'Erreur serveur lors de la mise à jour du profil.');
  }
});

// ---------- Mot de passe ----------
const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Mot de passe actuel requis.').max(200),
  // 72 octets : limite de bcrypt, au-delà le mot de passe serait tronqué en silence.
  newPassword: z
    .string()
    .min(8, 'Le nouveau mot de passe doit contenir au moins 8 caractères.')
    .max(72, 'Le nouveau mot de passe est trop long (72 caractères maximum).'),
});

router.post('/password', requireAuth, passwordLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Données invalides.');
    const { currentPassword, newPassword } = parsed.data;

    if (currentPassword === newPassword) return fail(res, 400, "Le nouveau mot de passe doit être différent de l'actuel.");

    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { password: true } });
    if (!user) return fail(res, 401, 'Utilisateur introuvable.');

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return fail(res, 400, 'Mot de passe actuel incorrect.');

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user!.id }, data: { password: hash } });

    return res.json({ success: true });
  } catch (err: unknown) {
    console.error('Erreur POST /settings/password :', err instanceof Error ? err.message : err);
    return fail(res, 500, 'Erreur serveur lors du changement de mot de passe.');
  }
});

// ---------- Tableau de bord personnel ----------
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

router.get('/dashboard', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rawDays = Number(req.query.days);
    const days = [7, 30, 90].includes(rawDays) ? rawDays : 30;
    const userId = req.user!.id;

    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)));
    const startKey = dayKey(start);

    const [me, views, sales, purchases, productsCount, followers, following, rating] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true, role: true } }),
      prisma.reelView.findMany({
        where: { product: { sellerId: userId }, day: { gte: startKey } },
        select: { day: true },
        take: 20000,
      }),
      prisma.order.findMany({
        where: { sellerId: userId, paidAt: { gte: start } },
        select: { paidAt: true, totalUSD: true },
        take: 5000,
      }),
      prisma.order.findMany({
        where: { buyerId: userId, createdAt: { gte: start } },
        select: { createdAt: true },
        take: 5000,
      }),
      prisma.product.count({ where: { sellerId: userId } }),
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
      prisma.sellerReview.aggregate({ where: { sellerId: userId }, _avg: { rating: true }, _count: { rating: true } }),
    ]);

    const series: { day: string; views: number; sales: number; revenueUSD: number; purchases: number }[] = [];
    const index = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const key = dayKey(new Date(start.getTime() + i * 86_400_000));
      index.set(key, series.length);
      series.push({ day: key, views: 0, sales: 0, revenueUSD: 0, purchases: 0 });
    }

    for (const v of views) {
      const i = index.get(v.day);
      if (i !== undefined) series[i].views += 1;
    }
    for (const s of sales) {
      if (!s.paidAt) continue;
      const i = index.get(dayKey(s.paidAt));
      if (i !== undefined) {
        series[i].sales += 1;
        series[i].revenueUSD += s.totalUSD;
      }
    }
    for (const p of purchases) {
      const i = index.get(dayKey(p.createdAt));
      if (i !== undefined) series[i].purchases += 1;
    }

    const totals = series.reduce(
      (t, d) => ({
        views: t.views + d.views,
        sales: t.sales + d.sales,
        revenueUSD: t.revenueUSD + d.revenueUSD,
        purchases: t.purchases + d.purchases,
      }),
      { views: 0, sales: 0, revenueUSD: 0, purchases: 0 }
    );

    return res.json({
      success: true,
      data: {
        days,
        role: me?.role ?? req.user!.role,
        memberSince: me?.createdAt ?? null,
        series: series.map((d) => ({ ...d, revenueUSD: Math.round(d.revenueUSD * 100) / 100 })),
        totals: { ...totals, revenueUSD: Math.round(totals.revenueUSD * 100) / 100 },
        profile: {
          productsCount,
          followers,
          following,
          ratingAvg: rating._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
          ratingCount: rating._count.rating,
        },
      },
    });
  } catch (err: unknown) {
    console.error('Erreur GET /settings/dashboard :', err instanceof Error ? err.message : err);
    return fail(res, 500, 'Erreur serveur lors du chargement du tableau de bord.');
  }
});

export default router;