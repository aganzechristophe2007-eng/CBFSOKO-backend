import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/reels
export async function getReels(_req: AuthRequest, res: Response) {
  try {
    const reels = await prisma.reel.findMany({
      include: {
        product: {
          include: {
            category: { select: { id: true, name: true } },
            _count: { select: { favorites: true } },
          },
        },
        seller: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const data = reels.map((r) => ({
      ...r,
      product: r.product ? { ...r.product, favoritesCount: r.product._count.favorites } : null,
    }));

    res.json({ data });
  } catch (err) {
    console.error('Erreur getReels', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// POST /api/reels  { videoUrl, thumbnail?, caption?, productId? }
export async function createReel(req: AuthRequest, res: Response) {
  try {
    const { videoUrl, thumbnail, caption, productId } = req.body;
    if (!videoUrl) return res.status(400).json({ message: 'videoUrl requis' });

    const reel = await prisma.reel.create({
      data: { videoUrl, thumbnail, caption, productId, sellerId: req.user!.id },
    });
    res.status(201).json({ data: reel });
  } catch (err) {
    console.error('Erreur createReel', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}
