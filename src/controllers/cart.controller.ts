import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/cart
export async function getCart(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Utilisateur non authentifié' });
    }

    const items = await prisma.cartItem.findMany({
      where: { userId },
      include: {
        product: {
          include: {
            category: {
              select: {
                id: true,
                name: true,
              },
            },
            seller: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.json({ data: items });
  } catch (err) {
    console.error('Erreur getCart:', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// POST /api/cart
// Body: { productId, quantity? }
export async function addToCart(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Utilisateur non authentifié' });
    }

    const { productId, quantity } = req.body;

    if (typeof productId !== 'string' || !productId.trim()) {
      return res.status(400).json({
        message: 'productId requis',
      });
    }

    const parsedQuantity =
      quantity === undefined ? 1 : Number(quantity);

    if (
      !Number.isInteger(parsedQuantity) ||
      parsedQuantity < 1
    ) {
      return res.status(400).json({
        message: 'Quantité invalide',
      });
    }

    const item = await prisma.cartItem.upsert({
      where: {
        userId_productId: {
          userId,
          productId,
        },
      },
      update: {
        quantity: {
          increment: parsedQuantity,
        },
      },
      create: {
        userId,
        productId,
        quantity: parsedQuantity,
      },
    });

    return res.status(201).json({
      data: item,
    });
  } catch (err) {
    console.error('Erreur addToCart:', err);
    return res.status(500).json({
      message: 'Erreur serveur',
    });
  }
}

// PUT /api/cart/:productId
// Body: { quantity }
export async function updateCartItem(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        message: 'Utilisateur non authentifié',
      });
    }

    const { productId } = req.params;

    if (typeof productId !== 'string' || !productId.trim()) {
      return res.status(400).json({
        message: 'productId invalide',
      });
    }

    const { quantity } = req.body;
    const parsedQuantity = Number(quantity);

    if (
      !Number.isInteger(parsedQuantity) ||
      parsedQuantity < 1
    ) {
      return res.status(400).json({
        message: 'Quantité invalide',
      });
    }

    const item = await prisma.cartItem.update({
      where: {
        userId_productId: {
          userId,
          productId,
        },
      },
      data: {
        quantity: parsedQuantity,
      },
    });

    return res.json({
      data: item,
    });
  } catch (err) {
    console.error('Erreur updateCartItem:', err);
    return res.status(500).json({
      message: 'Erreur serveur',
    });
  }
}

// DELETE /api/cart/:productId
export async function removeFromCart(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        message: 'Utilisateur non authentifié',
      });
    }

    const { productId } = req.params;

    if (typeof productId !== 'string' || !productId.trim()) {
      return res.status(400).json({
        message: 'productId invalide',
      });
    }

    await prisma.cartItem.deleteMany({
      where: {
        userId,
        productId,
      },
    });

    return res.json({
      message: 'Retiré du panier',
    });
  } catch (err) {
    console.error('Erreur removeFromCart:', err);
    return res.status(500).json({
      message: 'Erreur serveur',
    });
  }
}

