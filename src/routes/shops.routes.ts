import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import rateLimit from 'express-rate-limit';

/** /api/shops : annuaire public des boutiques (recherche, catégorie, tri, pagination). */
export function createShopsRouter({ prisma }: { prisma: PrismaClient }): Router {
  const router = Router();
  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Trop de requêtes. Réessaie dans un instant.' },
    })
  );

  // Nombre de boutiques créées depuis une date (badge « nouvelles boutiques » sur l'onglet Boutiques).
  router.get('/new-count', async (req: Request, res: Response) => {
    try {
      const since = new Date(String(req.query.since || ''));
      if (Number.isNaN(since.getTime())) return res.status(400).json({ success: false, error: 'Date invalide.' });
      const floor = Date.now() - 30 * 24 * 3600 * 1000; // jamais plus de 30 jours en arrière
      const from = new Date(Math.max(since.getTime(), floor));
      const count = await prisma.shop.count({ where: { createdAt: { gt: from } } });
      return res.status(200).json({ success: true, count });
    } catch (error) {
      console.error('Erreur /api/shops/new-count :', error);
      return res.status(500).json({ success: false, error: 'Erreur serveur.' });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
      const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : '';
      const sort = ['recent', 'name', 'products'].includes(String(req.query.sort)) ? String(req.query.sort) : 'recent';
      const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 24, 1), 60);
      const page = Math.max(parseInt(String(req.query.page), 10) || 1, 1);

      const shops = await prisma.shop.findMany({
        where: {
          ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
          ...(category ? { owner: { products: { some: { categoryId: category } } } } : {}),
        },
        select: { id: true, name: true, description: true, logo: true, verified: true, ownerId: true, createdAt: true },
        orderBy: sort === 'name' ? { name: 'asc' } : { createdAt: 'desc' },
        take: 200,
      });

      const ownerIds = shops.map((s) => s.ownerId);
      const [counts, byCategory] = ownerIds.length
        ? await Promise.all([
            prisma.product.groupBy({ by: ['sellerId'], where: { sellerId: { in: ownerIds } }, _count: { _all: true } }),
            prisma.product.groupBy({
              by: ['sellerId', 'categoryId'],
              where: { sellerId: { in: ownerIds } },
              _count: { _all: true },
            }),
          ])
        : [[], []];

      const countByOwner = new Map(counts.map((c) => [c.sellerId, c._count._all]));
      const topCategoryByOwner = new Map<string, { categoryId: string; n: number }>();
      for (const row of byCategory) {
        const current = topCategoryByOwner.get(row.sellerId);
        if (!current || row._count._all > current.n) topCategoryByOwner.set(row.sellerId, { categoryId: row.categoryId, n: row._count._all });
      }
      const categoryIds = [...new Set([...topCategoryByOwner.values()].map((v) => v.categoryId))];
      const categories = categoryIds.length
        ? await prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
        : [];
      const categoryName = new Map(categories.map((c) => [c.id, c.name]));

      let data = shops.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        logo: s.logo,
        verified: s.verified,
        createdAt: s.createdAt,
        ownerId: s.ownerId,
        productsCount: countByOwner.get(s.ownerId) ?? 0,
        category: categoryName.get(topCategoryByOwner.get(s.ownerId)?.categoryId ?? '') ?? null,
      }));
      if (sort === 'products') data = data.sort((a, b) => b.productsCount - a.productsCount);

      const total = data.length;
      return res.status(200).json({ success: true, data: data.slice((page - 1) * limit, page * limit), total, page, limit });
    } catch (error) {
      console.error('Erreur /api/shops :', error);
      return res.status(500).json({ success: false, error: 'Impossible de charger les boutiques.' });
    }
  });

  return router;
}
