import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/messages  (tous les messages où l'utilisateur est émetteur ou destinataire)
export async function getMessages(req: AuthRequest, res: Response) {
  try {
    const messages = await prisma.message.findMany({
      where: { OR: [{ senderId: req.user!.id }, { receiverId: req.user!.id }] },
      include: {
        sender: { select: { id: true, name: true, avatar: true } },
        receiver: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: messages });
  } catch (err) {
    console.error('Erreur getMessages', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// GET /api/messages/unread-count
export async function getUnreadCount(req: AuthRequest, res: Response) {
  try {
    const count = await prisma.message.count({
      where: { receiverId: req.user!.id, isRead: false },
    });
    res.json({ count });
  } catch (err) {
    console.error('Erreur getUnreadCount (messages)', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// POST /api/messages  { receiverId, content }
export async function sendMessage(req: AuthRequest, res: Response) {
  try {
    const { receiverId, content } = req.body;
    if (!receiverId || !content) return res.status(400).json({ message: 'receiverId et content requis' });

    const message = await prisma.message.create({
      data: { senderId: req.user!.id, receiverId, content },
    });

    await prisma.notification.create({
      data: {
        userId: receiverId,
        title: 'Nouveau message',
        message: `${req.user!.name} vous a envoyé un message`,
      },
    });

    res.status(201).json({ data: message });
  } catch (err) {
    console.error('Erreur sendMessage', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// POST /api/messages/mark-read
export async function markMessagesRead(req: AuthRequest, res: Response) {
  try {
    await prisma.message.updateMany({
      where: { receiverId: req.user!.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: 'Messages marqués comme lus' });
  } catch (err) {
    console.error('Erreur markMessagesRead', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}
