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

const serialize = (n: { id: string; type: string; title: string; message: string; link: string | null; isRead: boolean; createdAt: Date }) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  message: n.message,
  link: n.link,
  isRead: n.isRead,
  createdAt: n.createdAt,
});

/** /api/notifications : liste, compteur, lecture. Toujours limité à l'utilisateur connecté. */
export function createNotificationsRouter({ prisma, requireAuth, notifier }: Deps): Router {
  const router = Router();

  const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Trop de requêtes. Réessaie dans un instant.' },
  });
  router.use(requireAuth, readLimiter);

  // Liste paginée (curseur) : ?filter=all|unread&limit=20&cursor=<id>
  router.get('/', async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const filter = req.query.filter === 'unread' ? 'unread' : 'all';
      const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 20, 1), 50);
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;

      if (cursor) {
        const owned = await prisma.notification.findFirst({ where: { id: cursor, userId }, select: { id: true } });
        if (!owned) return res.status(400).json({ success: false, error: 'Curseur invalide.' });
      }

      const where = { userId, ...(filter === 'unread' ? { isRead: false } : {}) };
      const [rows, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        prisma.notification.count({ where: { userId, isRead: false } }),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return res.status(200).json({
        success: true,
        data: page.map(serialize),
        nextCursor: hasMore ? page[page.length - 1].id : null,
        unreadCount,
      });
    } catch (error) {
      console.error('Erreur /api/notifications (GET) :', error);
      return res.status(500).json({ success: false, error: 'Impossible de charger les notifications.' });
    }
  });

  router.get('/unread-count', async (req: AuthedRequest, res: Response) => {
    try {
      const unreadCount = await prisma.notification.count({ where: { userId: req.user!.id, isRead: false } });
      return res.status(200).json({ success: true, unreadCount });
    } catch (error) {
      console.error('Erreur /api/notifications/unread-count :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  router.patch('/read-all', async (req: AuthedRequest, res: Response) => {
    try {
      const result = await prisma.notification.updateMany({
        where: { userId: req.user!.id, isRead: false },
        data: { isRead: true },
      });
      return res.status(200).json({ success: true, updated: result.count, unreadCount: 0 });
    } catch (error) {
      console.error('Erreur /api/notifications/read-all :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  router.patch('/:id/read', async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const result = await prisma.notification.updateMany({
        where: { id: String(req.params.id), userId }, // un utilisateur ne peut jamais toucher la notification d'un autre
        data: { isRead: true },
      });
      if (result.count === 0) return res.status(404).json({ success: false, error: 'Notification introuvable.' });
      const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });
      return res.status(200).json({ success: true, unreadCount });
    } catch (error) {
      console.error('Erreur /api/notifications/:id/read :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  // Notification de test : crée une vraie notification pour soi-même et tente le push.
  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Trop de tests. Réessaie dans une minute.' },
  });
  router.post('/test', testLimiter, async (req: AuthedRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const result = await notifier.create({
        userId,
        type: 'SYSTEM',
        title: 'Notification de test',
        message: 'Si vous lisez ceci, vos notifications fonctionnent.',
        link: '/notifications',
        dedupeKey: `test:${userId}:${Date.now()}`,
      });
      return res.status(200).json({
        success: true,
        created: result.created,
        pushEnabled: notifier.pushEnabled,
        pushed: result.pushed,
      });
    } catch (error) {
      console.error('Erreur /api/notifications/test :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  return router;
}
