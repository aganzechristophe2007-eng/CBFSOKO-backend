import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// POST /api/feedback  { message }
export async function sendFeedback(req: AuthRequest, res: Response) {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ message: 'Message requis' });

    const feedback = await prisma.feedback.create({
      data: { message, userId: req.user?.id },
    });
    res.status(201).json({ data: feedback });
  } catch (err) {
    console.error('Erreur sendFeedback', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}
