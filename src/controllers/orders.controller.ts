import { Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { MESSAGE_INCLUDE, deliverMessage } from './messages.controller';

const DELIVERY_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 heures max laissées au vendeur pour confirmer
const SIMILAR_PRODUCTS_LIMIT = 6;

// Commission de la plateforme sur le prix du produit (hors livraison).
const PLATFORM_COMMISSION_RATE = 0.03; // 3%

// Barème de livraison, basé sur le poids total de l'envoi (poids unitaire × quantité).
// Standard "palier progressif" utilisé par la plupart des services de livraison locaux :
// un minimum forfaitaire pour les petits colis, puis un tarif au kg qui augmente par
// palier pour les envois lourds (le transport de charges lourdes coûte plus cher au kg,
// pas seulement proportionnellement).
function calculateDeliveryFeeCDF(unitWeightKg: number | null | undefined, quantity: number): number {
  const safeWeight = unitWeightKg && unitWeightKg > 0 ? unitWeightKg : 1; // défaut si non renseigné
  const safeQuantity = quantity > 0 ? quantity : 1;
  const totalWeight = safeWeight * safeQuantity;

  let fee: number;
  if (totalWeight <= 3) {
    fee = 2000; // forfait minimum, petits objets
  } else if (totalWeight <= 10) {
    fee = 2000 + (totalWeight - 3) * 1000;
  } else {
    fee = 2000 + 7 * 1000 + (totalWeight - 10) * 1500; // charges lourdes : palier plus cher
  }

  return Math.round(fee / 100) * 100; // arrondi au 100 CDF le plus proche
}

// Convertit un montant CDF en USD en réutilisant le taux réel de CETTE commande
// (order.totalCDF / order.totalUSD), pour rester cohérent avec le prix affiché au client
// plutôt que d'appliquer un taux global qui pourrait diverger.
function cdfToUsd(amountCDF: number, order: { totalUSD: number; totalCDF: number }): number {
  const rate = order.totalUSD > 0 && order.totalCDF > 0 ? order.totalCDF / order.totalUSD : 2300;
  return Math.round((amountCDF / rate) * 100) / 100;
}

// Revérifie toujours le rôle en base (jamais fait confiance à un éventuel claim de rôle
// présent dans le JWT, qui peut être obsolète si le rôle a changé depuis l'émission du token).
async function isCourierOrAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return !!user && ['COURIER', 'ADMIN', 'SUPER_ADMIN'].includes(user.role);
}

const deliveryRequestSchema = z.object({
  productId: z.string().min(1, 'productId requis'),
});

// Corps envoyé par l'app livreur lors du passage "Vérifié par CBFSOKO".
const courierVerifySchema = z.object({
  verificationNote: z.string().max(500).optional(),
  verificationPhotos: z.array(z.string().min(1)).max(8).optional(),
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
          weight: true,
          seller: { select: { id: true, name: true, avatar: true } },
        },
      },
    },
  },
  review: { select: { rating: true, comment: true } },
  courier: { select: { id: true, name: true, avatar: true } },
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

// GET /api/orders/:id/payment-summary — alimente PayPage.tsx
// Sécurité : réservé au buyer de cette commande, et seulement une fois que le livreur
// CBFSOKO a physiquement vérifié l'article (status COURIER_VERIFIED). Le paiement n'est
// PAS débloqué dès la simple confirmation du vendeur (CONFIRMED) : c'est précisément le
// contrôle qualité terrain qui doit précéder tout débit, conformément au pilier de confiance
// du produit. Tous les montants (livraison, commission, total) sont calculés ici, jamais
// reçus ni fait confiance depuis le client.
export async function getOrderPaymentSummary(req: AuthRequest, res: Response) {
  try {
    const buyerId = req.user!.id;
    const id = String(req.params.id);

    const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });
    if (order.buyerId !== buyerId) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }
    if (order.status !== 'COURIER_VERIFIED') {
      return res.status(409).json({ success: false, message: "Cette commande n'est pas encore prête pour le paiement." });
    }

    let totalWeightKg = 0;
    for (const item of order.items) {
      const unitWeight = item.product.weight && item.product.weight > 0 ? item.product.weight : 1;
      totalWeightKg += unitWeight * item.quantity;
    }
    const deliveryFeeCDF = calculateDeliveryFeeCDF(
      order.items[0]?.product.weight ?? null,
      order.items.reduce((sum, it) => sum + it.quantity, 0)
    );
    const commissionCDF = Math.round(order.totalCDF * PLATFORM_COMMISSION_RATE);
    const grandTotalCDF = order.totalCDF + deliveryFeeCDF + commissionCDF;

    return res.json({
      success: true,
      data: {
        order,
        totalWeightKg,
        subtotalCDF: order.totalCDF,
        subtotalUSD: order.totalUSD,
        deliveryFeeCDF,
        deliveryFeeUSD: cdfToUsd(deliveryFeeCDF, order),
        commissionRate: PLATFORM_COMMISSION_RATE,
        commissionCDF,
        commissionUSD: cdfToUsd(commissionCDF, order),
        grandTotalCDF,
        grandTotalUSD: cdfToUsd(grandTotalCDF, order),
      },
    });
  } catch (err) {
    console.error('Erreur getOrderPaymentSummary:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// PATCH /api/orders/:id/confirm — réservé au vendeur du produit concerné
export async function confirmOrder(req: AuthRequest, res: Response) {
  try {
    const sellerId = req.user!.id;
    const id = String(req.params.id);

    const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    // Jamais de confiance dans une valeur envoyée par le client : on revérifie toujours
    // le vendeur réel du produit en base.
    const product = order.items[0]?.product;
    if (!product || product.seller.id !== sellerId) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }

    // Ferme la faille de course : si le délai de 12h est dépassé mais que le balayage
    // périodique n'est pas encore passé, on expire la commande ici avant toute autre
    // vérification, pour empêcher un vendeur de confirmer "en retard" une commande que
    // l'acheteur voit déjà comme annulée côté front.
    const justExpired = await expireIfNeeded(order as any);
    if (justExpired) {
      return res.status(409).json({ success: false, message: 'Le délai de confirmation de 12h est dépassé, cette commande a expiré.' });
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
        message: `Le vendeur a confirmé la disponibilité de "${product.title}". Un livreur CBFSOKO va récupérer et vérifier l'article avant expédition.`,
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
    const id = String(req.params.id);

    const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    const product = order.items[0]?.product;
    if (!product || product.seller.id !== sellerId) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }

    // Même correctif de course que sur confirmOrder.
    const justExpired = await expireIfNeeded(order as any);
    if (justExpired) {
      return res.json({ success: true }); // déjà expirée, résultat équivalent pour le vendeur
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

// PATCH /api/orders/:id/verify — réservé aux livreurs CBFSOKO (rôle COURIER) et aux admins.
// C'est le passage physique du livreur chez le vendeur : il récupère l'article, vérifie sa
// conformité (photos/état) et, une fois satisfait, fait basculer la commande vers
// COURIER_VERIFIED. C'est CE statut, et non la simple confirmation du vendeur, qui débloque
// le paiement côté acheteur (voir getOrderPaymentSummary) — c'est le cœur du contrôle qualité
// "Vérifié par CBFSOKO".
export async function verifyOrderByCourier(req: AuthRequest, res: Response) {
  try {
    const courierId = req.user!.id;

    const authorized = await isCourierOrAdmin(courierId);
    if (!authorized) {
      return res.status(403).json({ success: false, message: 'Accès réservé aux livreurs CBFSOKO' });
    }

    const id = String(req.params.id);
    const parsed = courierVerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Requête invalide' });
    }
    const { verificationNote, verificationPhotos } = parsed.data;

    const order = await prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    // Seule une commande déjà confirmée par le vendeur peut passer en "vérifiée livreur" :
    // impossible de sauter l'étape de confirmation vendeur.
    if (order.status !== 'CONFIRMED') {
      return res.status(409).json({
        success: false,
        message: "Cette commande doit d'abord être confirmée par le vendeur avant la vérification livreur.",
      });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'COURIER_VERIFIED',
        courierId,
        verifiedAt: new Date(),
        verificationNote: verificationNote ?? null,
        verificationPhotos: verificationPhotos ?? [],
      },
      include: ORDER_INCLUDE,
    });

    const product = order.items[0]?.product;
    await prisma.notification.create({
      data: {
        userId: order.buyerId,
        title: 'Vérifié par CBFSOKO',
        message: product
          ? `"${product.title}" a été vérifié par notre livreur. Vous pouvez procéder au paiement en toute confiance.`
          : 'Votre article a été vérifié par notre livreur. Vous pouvez procéder au paiement.',
      },
    });

    return res.json({ success: true, order: updated });
  } catch (err) {
    console.error('Erreur verifyOrderByCourier:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}