import { Router, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { JWT_SECRET, requireAuth, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { getDashboard, updateOrderStatus } from '../controllers/admin-seller.controller';

const router = Router();

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const ADMIN_SESSION_MAX_AGE_S = 12 * 60 * 60; // une session admin ne vit que 12h, même si le cookie dure plus longtemps

// 1. Limite par utilisateur authentifié (et non par IP, qui est partagée derrière un proxy)
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin-seller:${(req as AuthRequest).user?.id ?? req.ip}`,
  handler: (_req, res) =>
    res.status(429).json({ success: false, error: 'Trop de requêtes.', message: 'Trop de requêtes.' }),
});

// 1 bis. Limite plus stricte pour les actions qui modifient des données
const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin-seller-action:${(req as AuthRequest).user?.id ?? req.ip}`,
  handler: (_req, res) =>
    res.status(429).json({ success: false, error: 'Trop de requêtes.', message: 'Trop de requêtes.' }),
});

// 2. Journalise toute tentative d'un compte non autorisé (le refus lui-même reste fait par requireRole)
const logDenied = (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
    console.warn(
      JSON.stringify({
        event: 'admin_access_denied',
        userId: req.user?.id ?? null,
        role: req.user?.role ?? null,
        ip: req.ip,
        path: req.originalUrl,
        at: new Date().toISOString(),
      }),
    );
  }
  next();
};

// 3. Session admin récente : un vieux token volé (cookie valide 7 à 30 jours) ne suffit plus pour entrer ici
const requireFreshAdminSession = (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const payload = jwt.verify(req.cookies?.token, JWT_SECRET, { algorithms: ['HS256'] }) as { iat?: number };
    const age = Math.floor(Date.now() / 1000) - (payload.iat ?? 0);
    if (!payload.iat || age > ADMIN_SESSION_MAX_AGE_S) {
      return res
        .status(401)
        .json({ success: false, message: 'Session administrateur expirée. Reconnectez-vous.' });
    }
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Session invalide ou expirée' });
  }
};

// Ordre voulu : identité (DB) -> journal -> rôle (DB) -> fraîcheur de session -> limite -> contrôleur
router.get(
  '/dashboard',
  requireAuth,
  logDenied,
  requireRole(...ADMIN_ROLES),
  requireFreshAdminSession,
  adminLimiter,
  getDashboard,
);

// Changement de statut d'une commande (Vérifiée / Annulée) : mêmes protections que le tableau de bord
router.patch(
  '/orders/:id/status',
  requireAuth,
  logDenied,
  requireRole(...ADMIN_ROLES),
  requireFreshAdminSession,
  adminActionLimiter,
  updateOrderStatus,
);

export default router;