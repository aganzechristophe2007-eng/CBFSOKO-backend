import { Response } from 'express';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// GET /api/orders
// Commandes de l'utilisateur connecté
export async function getMyOrders(req: AuthRequest, res: Response) {
  try {
    const orders = await prisma.order.findMany({
      where: { buyerId: req.user!.id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                title: true,
                images: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ data: orders });
  } catch (err) {
    console.error('Erreur getMyOrders:', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// GET /api/orders/:id
export async function getOrderById(req: AuthRequest, res: Response) {
  try {
    const id = String(req.params.id);

    if (!id) {
      return res.status(400).json({ message: 'ID de commande requis' });
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        message: 'Commande introuvable',
      });
    }

    // Un utilisateur ne peut consulter que ses propres commandes.
    // Les rôles privilégiés peuvent consulter les autres commandes.
    if (
      order.buyerId !== req.user!.id &&
      req.user!.role === 'USER'
    ) {
      return res.status(403).json({
        message: 'Accès refusé',
      });
    }

    return res.json({ data: order });
  } catch (err) {
    console.error('Erreur getOrderById:', err);
    return res.status(500).json({
      message: 'Erreur serveur',
    });
  }
}

/**
 * POST /api/orders
 * { deliveryAddress? }
 *
 * Transforme le panier de l'utilisateur connecté
 * en commande puis vide le panier.
 */
export async function createOrder(req: AuthRequest, res: Response) {
  try {
    const { deliveryAddress } = req.body;

    const cartItems = await prisma.cartItem.findMany({
      where: {
        userId: req.user!.id,
      },
      include: {
        product: true,
      },
    });

    if (cartItems.length === 0) {
      return res.status(400).json({
        message: 'Le panier est vide',
      });
    }

    const totalUSD = cartItems.reduce(
      (sum, item) =>
        sum + item.product.priceUSD * item.quantity,
      0
    );

    const totalCDF = cartItems.reduce(
      (sum, item) =>
        sum + item.product.priceCDF * item.quantity,
      0
    );

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          buyerId: req.user!.id,
          totalUSD,
          totalCDF,
          deliveryAddress,

          items: {
            create: cartItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              priceUSD: item.product.priceUSD,
              priceCDF: item.product.priceCDF,
            })),
          },
        },

        include: {
          items: true,
        },
      });

      await tx.cartItem.deleteMany({
        where: {
          userId: req.user!.id,
        },
      });

      return created;
    });

    return res.status(201).json({
      data: order,
    });
  } catch (err) {
    console.error('Erreur createOrder:', err);

    return res.status(500).json({
      message: 'Erreur serveur',
    });
  }
}

// PUT /api/orders/:id/status
// { status }
export async function updateOrderStatus(
  req: AuthRequest,
  res: Response
) {
  try {
    const id = String(req.params.id);
    const { status } = req.body;

    if (!id) {
      return res.status(400).json({
        message: 'ID de commande requis',
      });
    }

    if (!status) {
      return res.status(400).json({
        message: 'Statut requis',
      });
    }

    const order = await prisma.order.update({
      where: { id },
      data: { status },
    });

    return res.json({
      data: order,
    });
  } catch (err) {
    console.error('Erreur updateOrderStatus:', err);

    return res.status(500).json({
      message: 'Erreur serveur',
    });
  }
}
