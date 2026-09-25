import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';

export interface AuthRequest extends Request {
  user?: { id: string; role: string; email: string; name: string };
  cookies: { [key: string]: string };
}

// Plus aucun secret par défaut dans le code : le serveur refuse de démarrer sans un vrai secret.
const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET manquant ou trop court (32 caractères minimum). Définissez-le dans les variables d\'environnement.');
}

/**
 * Exige un token valide via un cookie HttpOnly. Bloque la requête (401) s'il est absent/invalide.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.token;
    if (!token) return res.status(401).json({ success: false, message: 'Non authentifié' });

    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: string };
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user) return res.status(401).json({ success: false, message: 'Utilisateur introuvable' });

    req.user = { id: user.id, role: user.role, email: user.email, name: user.name };
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Session invalide ou expirée' });
  }
}

/**
 * N'échoue jamais : attache req.user si un token valide est présent dans le cookie,
 * sinon laisse passer (routes publiques enrichies).
 */
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.token;
    if (!token) return next();

    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: string };
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (user) req.user = { id: user.id, role: user.role, email: user.email, name: user.name };
  } catch {
    // token invalide -> on continue sans req.user
  }
  next();
}

/**
 * Restreint l'accès à certains rôles (ex: requireRole('ADMIN', 'SUPER_ADMIN')).
 */
export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }
    next();
  };
}

export { JWT_SECRET };