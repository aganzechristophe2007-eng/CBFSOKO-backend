import { Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { MESSAGE_INCLUDE, deliverMessage } from './messages.controller';

const DELIVERY_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 heures
const SIMILAR_PRODUCTS_LIMIT = 6;

const deliveryRequestSchema = z.object({
  productId: z.string().min(1, 'productId requis'),
});

// Ce que le front (Orders.tsx) affiche pour une commande : produit, vendeur, prix, statut, chrono.
const ORDER_INCLUDE = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          title: true,
          images: true,
          priceUSD: true,
          priceCDF: true,
          categoryId: true,
          isSold: true,
          seller: { select: { id: true, name: true, avatar: true } },
        },
      },
    },
  },
} as const;

async function findSimilarProducts(categoryId: string, excludeProductId: string) {
  return prisma.product.findMany({
    where: { categoryId, id: { not: excludeProductId }, isSold: false },
    select: { id: true, title: true, images: true, priceUSD: true, priceCDF: true, location: true },
    orderBy: { createdAt: 'desc' },
    take: SIMILAR_PRODUCTS_LIMIT,
  });
}

// Bascule une commande en attente dont le délai est dépassé vers EXPIRED, prévient l'acheteur
// (notification) et ne fait rien si elle n'est pas concernée. Appelée à la lecture (lazy) ET
// par le balayage périodique dans server.ts — Render (gratuit) peut mettre le service en veille,
// donc on ne compte pas uniquement sur le minuteur en mémoire.
async function expireIfNeeded(order: {
  id: string;
  status: string;
  expiresAt: Date | null;
  buyerId: string;
  items: { product: { id: string; title: string; categoryId: string } }[];
}) {
  if (order.status !== 'AWAITING_SELLER_CONFIRMATION' || !order.expiresAt || order.expiresAt > new Date()) {
    return false;
  }

  await prisma.order.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });

  const product = order.items[0]?.product;
  await prisma.notification.create({
    data: {
      userId: order.buyerId,
      title: 'Produit indisponible',
      message: product
        ? `"${product.title}" n'est plus disponible. Découvrez des produits similaires.`
        : "Ce produit n'est plus disponible.",
    },
  });

  return true;
}

// Appelée toutes les quelques minutes depuis server.ts : rattrape les expirations
// même si personne n'a rouvert l'app entre-temps.
export async function sweepExpiredOrders() {
  const candidates = await prisma.order.findMany({
    where: { status: 'AWAITING_SELLER_CONFIRMATION', expiresAt: { lte: new Date() } },
    include: { items: { include: { product: { select: { id: true, title: true, categoryId: true } } } } },
  });

  for (const order of candidates) {
    await expireIfNeeded(order as any);
  }
}

// POST /api/orders/delivery-request
// Déclenchée par le bouton "Me faire livrer" d'un reel.
export async function createDeliveryRequest(req: AuthRequest, res: Response) {
  try {
    const buyerId = req.user!.id;
    const parsed = deliveryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Requête invalide' });
    }
    const { productId } = parsed.data;

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, title: true, priceUSD: true, priceCDF: true, sellerId: true, isSold: true, categoryId: true },
    });
    if (!product) return res.status(404).json({ success: false, message: 'Produit introuvable' });
    if (product.sellerId === buyerId) {
      return res.status(400).json({ success: false, message: 'Vous ne pouvez pas commander votre propre produit' });
    }
    if (product.isSold) {
      return res.status(409).json({ success: false, message: 'Ce produit est déjà vendu' });
    }

    // Anti-spam : une seule demande active à la fois pour ce produit par cet acheteur.
    const existingActive = await prisma.order.findFirst({
      where: {
        buyerId,
        status: 'AWAITING_SELLER_CONFIRMATION',
        items: { some: { productId: product.id } },
      },
      include: ORDER_INCLUDE,
    });
    if (existingActive) {
      return res.status(200).json({ success: true, order: existingActive, alreadyRequested: true });
    }

    const expiresAt = new Date(Date.now() + DELIVERY_TIMEOUT_MS);

    const order = await prisma.order.create({
      data: {
        buyerId,
        sellerId: product.sellerId,
        totalUSD: product.priceUSD,
        totalCDF: product.priceCDF,
        status: 'AWAITING_SELLER_CONFIRMATION',
        expiresAt,
        items: {
          create: [{ productId: product.id, quantity: 1, priceUSD: product.priceUSD, priceCDF: product.priceCDF }],
        },
      },
      include: ORDER_INCLUDE,
    });

    // Message automatique au vendeur, dans la vraie messagerie (donc visible dans Messages.tsx),
    // avec orderId pour que le front affiche les boutons Confirmer / Indisponible.
    const message = await prisma.message.create({
      data: {
        senderId: buyerId,
        receiverId: product.sellerId,
        type: 'ORDER_REQUEST',
        content: `Un acheteur souhaite se faire livrer « ${product.title} ». Confirmez-vous que ce produit est toujours disponible ?`,
        orderId: order.id,
      },
      include: MESSAGE_INCLUDE,
    });
    await deliverMessage(message as any);

    return res.status(201).json({ success: true, order });
  } catch (err) {
    console.error('Erreur createDeliveryRequest:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// GET /api/orders/mine — alimente Orders.tsx
export async function getMyOrders(req: AuthRequest, res: Response) {
  try {
    const buyerId = req.user!.id;

    const orders = await prisma.order.findMany({
      where: { buyerId },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    const result = [];
    for (const order of orders) {
      const justExpired = await expireIfNeeded(order as any);
      const status = justExpired ? 'EXPIRED' : order.status;
      const product = order.items[0]?.product;

      let similarProducts: Awaited<ReturnType<typeof findSimilarProducts>> = [];
      if (status === 'EXPIRED' && product) {
        similarProducts = await findSimilarProducts(product.categoryId, product.id);
      }

      result.push({ ...order, status, similarProducts });
    }

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('Erreur getMyOrders:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// PATCH /api/orders/:id/confirm — réservé au vendeur du produit concerné
export async function confirmOrder(req: AuthRequest, res: Response) {
  try {
    const sellerId = req.user!.id;
    const { id } = req.params;

    const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    // Jamais de confiance dans une valeur envoyée par le client : on revérifie toujours
    // le vendeur réel du produit en base.
    const product = order.items[0]?.product;
    if (!product || product.seller.id !== sellerId) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }
    if (order.status !== 'AWAITING_SELLER_CONFIRMATION') {
      return res.status(409).json({ success: false, message: 'Cette commande ne peut plus être confirmée' });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
      include: ORDER_INCLUDE,
    });

    await prisma.notification.create({
      data: {
        userId: order.buyerId,
        title: 'Produit confirmé',
        message: `Le vendeur a confirmé la disponibilité de "${product.title}". Votre commande est en cours.`,
      },
    });

    return res.json({ success: true, order: updated });
  } catch (err) {
    console.error('Erreur confirmOrder:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// PATCH /api/orders/:id/deny — le vendeur signale que le produit n'est plus disponible
export async function denyOrder(req: AuthRequest, res: Response) {
  try {
    const sellerId = req.user!.id;
    const { id } = req.params;

    const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    const product = order.items[0]?.product;
    if (!product || product.seller.id !== sellerId) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }
    if (order.status !== 'AWAITING_SELLER_CONFIRMATION') {
      return res.status(409).json({ success: false, message: 'Cette commande ne peut plus être modifiée' });
    }

    await prisma.order.update({ where: { id }, data: { status: 'EXPIRED' } });

    await prisma.notification.create({
      data: {
        userId: order.buyerId,
        title: 'Produit indisponible',
        message: `"${product.title}" n'est plus disponible. Découvrez des produits similaires.`,
      },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Erreur denyOrder:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}