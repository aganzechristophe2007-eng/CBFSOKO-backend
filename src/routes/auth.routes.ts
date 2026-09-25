import { Router, Request, Response, CookieOptions } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { JWT_SECRET, requireAuth, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 jours
const BCRYPT_ROUNDS = 12;
const isProd = process.env.NODE_ENV === 'production';

// Frontend et backend sur des domaines différents (ex: Vercel + Render) -> COOKIE_SAMESITE=none
const sameSite = (process.env.COOKIE_SAMESITE as 'strict' | 'lax' | 'none') || 'strict';

const baseCookie: CookieOptions = {
  httpOnly: true,
  secure: isProd || sameSite === 'none',
  sameSite,
  path: '/',
};

// Hash factice : on compare toujours un hash, même si l'email n'existe pas (anti "timing attack")
const DUMMY_HASH = bcrypt.hashSync('mot-de-passe-factice-anti-timing', BCRYPT_ROUNDS);

// ---------- Validation ----------
const emailSchema = z.string().trim().toLowerCase().email().max(254);

const passwordSchema = z
  .string()
  .min(8, 'Le mot de passe doit contenir au moins 8 caractères.')
  .max(72, 'Le mot de passe ne doit pas dépasser 72 caractères.') // limite de bcrypt
  .regex(/[A-Za-z]/, 'Le mot de passe doit contenir au moins une lettre.')
  .regex(/\d/, 'Le mot de passe doit contenir au moins un chiffre.');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Nom trop court.').max(60, 'Nom trop long.'),
  email: emailSchema,
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{8,15}$/, 'Numéro de téléphone invalide.')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  password: passwordSchema,
});
// Note : z.object() ignore tout champ inconnu -> impossible de s'attribuer un "role" ADMIN via le body.

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72),
});

// ---------- Anti brute-force ----------
const tooMany = (_req: Request, res: Response) =>
  res.status(429).json({
    success: false,
    error: 'Trop de tentatives. Réessayez dans quelques minutes.',
    message: 'Trop de tentatives. Réessayez dans quelques minutes.',
  });

const loginIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, handler: tooMany });
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `login:${String(req.body?.email ?? '').toLowerCase().trim().slice(0, 254)}`,
  handler: tooMany,
});
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, handler: tooMany });

// ---------- Utilitaires ----------
const fail = (res: Response, status: number, msg: string) =>
  res.status(status).json({ success: false, error: msg, message: msg });

const issueSession = (res: Response, userId: string) => {
  const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS, algorithm: 'HS256' });
  res.cookie('token', token, { ...baseCookie, maxAge: TOKEN_TTL_SECONDS * 1000 });
};

// ==========================================
// INSCRIPTION
// ==========================================
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return fail(res, 400, parsed.error.issues[0]?.message || 'Données invalides.');
  }
  const { name, email, phone, password } = parsed.data;

  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
      select: { id: true },
    });
    if (existing) return fail(res, 409, 'Un compte existe déjà avec cet email ou ce téléphone.');

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { name, email, phone: phone ?? null, password: hashed },
      });
      await tx.wallet.create({ data: { userId: created.id } });
      return created;
    });

    issueSession(res, user.id);
    const { password: _pw, ...safeUser } = user;
    return res.status(201).json({ success: true, user: safeUser });
  } catch (err: any) {
    if (err?.code === 'P2002') return fail(res, 409, 'Un compte existe déjà avec cet email ou ce téléphone.');
    console.error('Erreur register:', err?.message || err);
    return fail(res, 500, 'Erreur serveur. Réessayez plus tard.');
  }
});

// ==========================================
// CONNEXION (plus de création automatique de compte)
// ==========================================
router.post('/login', loginIpLimiter, loginEmailLimiter, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'Email et mot de passe requis.');
  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { email }, include: { wallet: true } });

    // On compare TOUJOURS un hash : même durée que l'email existe ou non
    const valid = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);

    // Même message dans tous les cas : ne révèle pas si l'email existe
    if (!user || !valid) return fail(res, 401, 'Email ou mot de passe incorrect.');

    issueSession(res, user.id);
    const { password: _pw, ...safeUser } = user;
    return res.status(200).json({ success: true, user: safeUser });
  } catch (err: any) {
    console.error('Erreur login:', err?.message || err);
    return fail(res, 500, 'Erreur serveur. Réessayez plus tard.');
  }
});

// ==========================================
// UTILISATEUR CONNECTÉ (utilisé par AuthContext au chargement)
// ==========================================
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { shop: true, wallet: true },
    });
    if (!user) return fail(res, 401, 'Session invalide.');
    const { password: _pw, ...safeUser } = user;
    return res.json({ success: true, user: safeUser });
  } catch (err: any) {
    console.error('Erreur me:', err?.message || err);
    return fail(res, 500, 'Erreur serveur.');
  }
});

// ==========================================
// DÉCONNEXION
// ==========================================
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token', baseCookie);
  return res.status(200).json({ success: true });
});

export default router;