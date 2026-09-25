import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

const CALL_INCLUDE = {
  caller: { select: { id: true, name: true, avatar: true } },
  receiver: { select: { id: true, name: true, avatar: true } },
};

export async function logCall(req: AuthRequest, res: Response) {
  try {
    const callerId = req.user!.id;
    const { receiverId, type, status, duration } = req.body;

    if (!receiverId || receiverId === callerId) return res.status(400).json({ message: 'receiverId invalide' });
    if (!['AUDIO', 'VIDEO'].includes(type)) return res.status(400).json({ message: 'type invalide' });
    if (!['MISSED', 'ANSWERED', 'DECLINED'].includes(status)) return res.status(400).json({ message: 'status invalide' });

    const call = await prisma.call.create({
      data: {
        callerId,
        receiverId,
        type,
        status,
        duration: Number.isFinite(Number(duration)) ? Math.max(0, parseInt(String(duration), 10)) : 0,
      },
      include: CALL_INCLUDE,
    });

    res.status(201).json({ data: call });
  } catch (err) {
    console.error('Erreur logCall', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

export async function getCallHistory(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const calls = await prisma.call.findMany({
      where: { OR: [{ callerId: userId }, { receiverId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: CALL_INCLUDE,
    });
    res.json({ data: calls });
  } catch (err) {
    console.error('Erreur getCallHistory', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}