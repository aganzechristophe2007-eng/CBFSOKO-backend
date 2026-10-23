import { Router, Request, Response, RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import rateLimit from 'express-rate-limit';

type AuthedRequest = Request & { user?: { id: string } };

/** /api/favorites : favoris de l'utilisateur connecté (jamais ceux d'un autre). */
export function createFavoritesRouter({ prisma, requireAuth }: { prisma: PrismaClient; requireAuth: RequestHandler }): Router {
  const router = Router();
  router.use(
    requireAuth,
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Trop de requêtes. Réessaie dans un instant.' },
    })
  );

  router.get('/ids', async (req: AuthedRequest, res: Response) => {
    try {
      const rows = await prisma.favorite.findMany({ where: { userId: req.user!.id }, select: { productId: true }, take: 1000 });
      return res.status(200).json({ success: true, ids: rows.map((r) => r.productId) });
    } catch (error) {
      console.error('Erreur /api/favorites/ids :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  router.get('/', async (req: AuthedRequest, res: Response) => {
    try {
      const rows = await prisma.favorite.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { product: { select: { id: true, title: true, priceUSD: true, priceCDF: true, images: true, isSold: true } } },
      });
      return res.status(200).json({ success: true, data: rows.map((r) => r.product) });
    } catch (error) {
      console.error('Erreur /api/favorites :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  // Idempotent : ajouter deux fois le même favori ne crée rien de plus.
  router.post('/:productId', async (req: AuthedRequest, res: Response) => {
    try {
      const productId = String(req.params.productId);
      const userId = req.user!.id;
      const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
      if (!product) return res.status(404).json({ success: false, error: 'Produit introuvable.' });

      const existing = await prisma.favorite.findUnique({ where: { userId_productId: { userId, productId } }, select: { id: true } });
      if (!existing) {
        try {
          await prisma.$transaction([
            prisma.favorite.create({ data: { userId, productId } }),
            prisma.product.update({ where: { id: productId }, data: { favoritesCount: { increment: 1 } } }),
          ]);
        } catch (error: any) {
          if (error?.code !== 'P2002') throw error; // course entre deux requêtes : déjà ajouté
        }
      }
      return res.status(200).json({ success: true, favorite: true });
    } catch (error) {
      console.error('Erreur /api/favorites (POST) :', error);
      return res.status(500).json({ success: false, error: 'Impossible d\'ajouter aux favoris.' });
    }
  });

  router.delete('/:productId', async (req: AuthedRequest, res: Response) => {
    try {
      const productId = String(req.params.productId);
      const userId = req.user!.id;
      const result = await prisma.favorite.deleteMany({ where: { userId, productId } });
      if (result.count > 0) {
        await prisma.product.updateMany({ where: { id: productId, favoritesCount: { gt: 0 } }, data: { favoritesCount: { decrement: 1 } } });
      }
      return res.status(200).json({ success: true, favorite: false });
    } catch (error) {
      console.error('Erreur /api/favorites (DELETE) :', error);
      return res.status(500).json({ success: false, error: 'Impossible de retirer des favoris.' });
    }
  });

  return router;
}
