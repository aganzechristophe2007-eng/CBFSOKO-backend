import { Response } from 'express';
import multer from 'multer';
import prisma from '../lib/prisma';
import { uploadBufferToCloudinary } from '../lib/cloudinary';
import { AuthRequest } from '../middleware/auth.middleware';
import { getIO, isUserOnline, activeConversation } from '../services/socket.service';

const MESSAGE_INCLUDE = { sender: { select: { id: true, name: true, avatar: true } } };

export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp',
      'audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
      'video/mp4', 'video/quicktime', 'video/webm',
    ];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Format de fichier non autorisé.'));
    cb(null, true);
  },
});

type MessageWithSender = Awaited<ReturnType<typeof prisma.message.create>> & {
  sender: { id: string; name: string; avatar: string | null };
};

async function deliverMessage(message: MessageWithSender) {
  const io = getIO();
  io.to(`user:${message.receiverId}`).emit('message:new', message);
  io.to(`user:${message.senderId}`).emit('message:sent', message);

  const receiverIsViewingThisChat = activeConversation.get(message.receiverId) === message.senderId;
  if (!receiverIsViewingThisChat) {
    const label =
      message.type === 'TEXT' ? 'vous a envoyé un message'
      : message.type === 'IMAGE' ? 'vous a envoyé une photo'
      : message.type === 'AUDIO' ? 'vous a envoyé un message vocal'
      : 'vous a envoyé une vidéo';
    await prisma.notification.create({
      data: { userId: message.receiverId, title: 'Nouveau message', message: `${message.sender.name} ${label}` },
    });
  }
}

export async function getConversations(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const [sent, received] = await Promise.all([
      prisma.message.findMany({ where: { senderId: userId }, select: { receiverId: true }, distinct: ['receiverId'] }),
      prisma.message.findMany({ where: { receiverId: userId }, select: { senderId: true }, distinct: ['senderId'] }),
    ]);
    const partnerIds = Array.from(new Set([...sent.map((s) => s.receiverId), ...received.map((r) => r.senderId)]));

    const conversations = await Promise.all(
      partnerIds.map(async (partnerId) => {
        const [lastMessage, unreadCount, partner] = await Promise.all([
          prisma.message.findFirst({
            where: { OR: [{ senderId: userId, receiverId: partnerId }, { senderId: partnerId, receiverId: userId }] },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.message.count({ where: { senderId: partnerId, receiverId: userId, isRead: false } }),
          prisma.user.findUnique({ where: { id: partnerId }, select: { id: true, name: true, avatar: true } }),
        ]);
        return { partner, lastMessage, unreadCount, online: isUserOnline(partnerId) };
      })
    );

    conversations.sort((a, b) => {
      const at = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bt = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bt - at;
    });

    res.json({ data: conversations });
  } catch (err) {
    console.error('Erreur getConversations', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

export async function getConversationMessages(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const contactId = String(req.params.contactId);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '30'), 10) || 30, 1), 50);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const messages = await prisma.message.findMany({
      where: { OR: [{ senderId: userId, receiverId: contactId }, { senderId: contactId, receiverId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    res.json({
      data: messages.reverse(),
      nextCursor: messages.length === limit ? messages[0].id : null,
    });
  } catch (err) {
    console.error('Erreur getConversationMessages', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

export async function getUnreadCount(req: AuthRequest, res: Response) {
  try {
    const count = await prisma.message.count({ where: { receiverId: req.user!.id, isRead: false } });
    res.json({ count });
  } catch (err) {
    console.error('Erreur getUnreadCount', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

export async function sendMessage(req: AuthRequest, res: Response) {
  try {
    const senderId = req.user!.id;
    const { receiverId, content } = req.body;

    if (!receiverId || typeof receiverId !== 'string') return res.status(400).json({ message: 'receiverId requis' });
    if (receiverId === senderId) return res.status(400).json({ message: "Impossible de s'envoyer un message à soi-même" });

    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) return res.status(400).json({ message: 'Le message est vide' });
    if (text.length > 4000) return res.status(400).json({ message: 'Message trop long (4000 caractères maximum)' });

    const receiverExists = await prisma.user.findUnique({ where: { id: receiverId }, select: { id: true } });
    if (!receiverExists) return res.status(404).json({ message: 'Destinataire introuvable' });

    const message = await prisma.message.create({
      data: { senderId, receiverId, type: 'TEXT', content: text },
      include: MESSAGE_INCLUDE,
    });

    await deliverMessage(message);
    res.status(201).json({ data: message });
  } catch (err) {
    console.error('Erreur sendMessage', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

export async function sendMediaMessage(req: AuthRequest, res: Response) {
  try {
    const senderId = req.user!.id;
    const { receiverId, type, duration, content } = req.body;
    const file = req.file;

    if (!receiverId || typeof receiverId !== 'string') return res.status(400).json({ message: 'receiverId requis' });
    if (receiverId === senderId) return res.status(400).json({ message: "Impossible de s'envoyer un message à soi-même" });
    if (!file) return res.status(400).json({ message: 'Fichier requis' });

    const VALID_TYPES = ['IMAGE', 'AUDIO', 'VIDEO'] as const;
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ message: 'Type de média invalide' });

    const receiverExists = await prisma.user.findUnique({ where: { id: receiverId }, select: { id: true } });
    if (!receiverExists) return res.status(404).json({ message: 'Destinataire introuvable' });

    const resourceType = type === 'IMAGE' ? 'image' : 'video';
    const uploadResult = await uploadBufferToCloudinary(file.buffer, {
      resource_type: resourceType,
      folder: `cbfsoko/messages/${type.toLowerCase()}`,
    });

    const message = await prisma.message.create({
      data: {
        senderId,
        receiverId,
        type,
        content: typeof content === 'string' && content.trim() ? content.trim().slice(0, 1000) : null,
        mediaUrl: uploadResult.secure_url,
        mediaPublicId: uploadResult.public_id,
        mediaDuration: duration ? parseInt(String(duration), 10) : uploadResult.duration ? Math.round(uploadResult.duration) : null,
      },
      include: MESSAGE_INCLUDE,
    });

    await deliverMessage(message);
    res.status(201).json({ data: message });
  } catch (err) {
    console.error('Erreur sendMediaMessage', err);
    res.status(500).json({ message: "Erreur lors de l'envoi du média" });
  }
}

export async function markConversationRead(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const contactId = String(req.params.contactId);

    await prisma.message.updateMany({
      where: { senderId: contactId, receiverId: userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    getIO().to(`user:${contactId}`).emit('message:read', { by: userId });
    res.json({ message: 'Conversation marquée comme lue' });
  } catch (err) {
    console.error('Erreur markConversationRead', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}