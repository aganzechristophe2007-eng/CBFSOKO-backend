import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/favorites/me
export async function getMyFavorites(req: AuthRequest, res: Response) {
  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user!.id },
      include: {
        product: {
          include: {
            category: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true, avatar: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: favorites });
  } catch (err) {
    console.error('Erreur getMyFavorites', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}
