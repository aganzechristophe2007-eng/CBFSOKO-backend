import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

export async function getCategories(_req: AuthRequest, res: Response) {
  try {
    const categories = await prisma.category.findMany({
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: categories.map((c) => ({ ...c, productsCount: c._count.products })) });
  } catch (err) {
    console.error('Erreur getCategories', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

export async function createCategory(req: AuthRequest, res: Response) {
  try {
    const { name, icon } = req.body;
    if (!name) return res.status(400).json({ message: 'Nom requis' });
    const slug = String(name)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const category = await prisma.category.create({ data: { name, slug, icon } });
    res.status(201).json({ data: category });
  } catch (err) {
    console.error('Erreur createCategory', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}
