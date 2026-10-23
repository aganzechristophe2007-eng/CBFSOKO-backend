import { Router, Request, Response, RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import rateLimit from 'express-rate-limit';
import type { NotificationService } from '../services/notifications.service';

type AuthedRequest = Request & { user?: { id: string } };

interface Deps {
  prisma: PrismaClient;
  requireAuth: RequestHandler;
  notifier: NotificationService;
}

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const isKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_\-+/=]+$/.test(value);

/** /api/push : abonnement Web Push de l'appareil courant. */
export function createPushRouter({ prisma, requireAuth, notifier }: Deps): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Trop de requêtes. Réessaie dans un instant.' },
  });

  // Public : permet au site de savoir si le push est réellement disponible sur ce serveur.
  router.get('/config', limiter, (_req: Request, res: Response) => {
    return res.status(200).json({ success: true, enabled: notifier.pushEnabled, publicKey: notifier.publicKey });
  });

  router.post('/subscribe', requireAuth, limiter, async (req: AuthedRequest, res: Response) => {
    try {
      if (!notifier.pushEnabled) {
        return res.status(503).json({ success: false, error: 'Les notifications push ne sont pas configurées sur ce serveur.' });
      }
      const sub = req.body?.subscription;
      const endpoint = sub?.endpoint;
      const p256dh = sub?.keys?.p256dh;
      const auth = sub?.keys?.auth;
      if (!isHttpsUrl(endpoint) || !isKey(p256dh) || !isKey(auth)) {
        return res.status(400).json({ success: false, error: 'Abonnement invalide.' });
      }
      const userAgent = typeof req.body?.userAgent === 'string' ? req.body.userAgent.slice(0, 300) : null;
      const userId = req.user!.id;

      // Un même appareil ne peut appartenir qu'à un seul compte à la fois : l'abonnement suit l'utilisateur connecté.
      await prisma.pushSubscription.upsert({
        where: { endpoint },
        update: { userId, p256dh, auth, userAgent },
        create: { userId, endpoint, p256dh, auth, userAgent },
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Erreur /api/push/subscribe :', error);
      return res.status(500).json({ success: false, error: 'Impossible d\'enregistrer l\'abonnement.' });
    }
  });

  router.post('/unsubscribe', requireAuth, limiter, async (req: AuthedRequest, res: Response) => {
    try {
      const endpoint = req.body?.endpoint;
      if (!isHttpsUrl(endpoint)) return res.status(400).json({ success: false, error: 'Abonnement invalide.' });
      await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Erreur /api/push/unsubscribe :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  // Vérifie que le serveur connaît bien cet appareil pour cet utilisateur (évite d'afficher "activé" à tort).
  router.post('/status', requireAuth, limiter, async (req: AuthedRequest, res: Response) => {
    try {
      const endpoint = req.body?.endpoint;
      if (!isHttpsUrl(endpoint)) return res.status(200).json({ success: true, subscribed: false });
      const found = await prisma.pushSubscription.findFirst({
        where: { endpoint, userId: req.user!.id },
        select: { id: true },
      });
      return res.status(200).json({ success: true, subscribed: !!found });
    } catch (error) {
      console.error('Erreur /api/push/status :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  return router;
}
