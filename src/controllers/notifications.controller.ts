import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/notifications
export async function getNotifications(req: AuthRequest, res: Response) {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ data: notifications });
  } catch (err) {
    console.error('Erreur getNotifications', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// GET /api/notifications/unread-count
export async function getUnreadNotifCount(req: AuthRequest, res: Response) {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user!.id, isRead: false },
    });
    res.json({ count });
  } catch (err) {
    console.error('Erreur getUnreadNotifCount', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// POST /api/notifications/mark-read
export async function markNotificationsRead(req: AuthRequest, res: Response) {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: 'Notifications marquées comme lues' });
  } catch (err) {
    console.error('Erreur markNotificationsRead', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}
