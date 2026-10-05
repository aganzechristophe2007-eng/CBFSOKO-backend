import { Response } from 'express';
import { z } from 'zod';
import { OrderStatus, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';

// Bukavu : Africa/Lubumbashi (UTC+2, sans heure d'été)
const TZ = 'Africa/Lubumbashi';
const TZ_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const startOfLocalDay = (d: Date) =>
  new Date(Math.floor((d.getTime() + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS);

const dayKey = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const pct = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);

const sellerSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  name: true,
  phone: true,
  avatar: true,
  shop: { select: { name: true } },
});

const orderSelect = Prisma.validator<Prisma.OrderSelect>()({
  id: true,
  status: true,
  totalUSD: true,
  totalCDF: true,
  deliveryAddress: true,
  createdAt: true,
  expiresAt: true,
  confirmedAt: true,
  courierAssignedAt: true,
  verifiedAt: true,
  buyer: { select: { id: true, name: true } },
  courier: { select: { id: true, name: true, phone: true, avatar: true } },
  items: {
    take: 1,
    select: {
      quantity: true,
      product: { select: { id: true, title: true, images: true, seller: { select: sellerSelect } } },
    },
  },
  _count: { select: { items: true } },
});

type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

// Le vendeur d'une commande est déduit du produit (Order.sellerId n'est renseigné que pour les réservations de reel).
const toOrderDto = (o: OrderRow) => {
  const first = o.items[0];
  const product = first?.product ?? null;
  return {
    id: o.id,
    status: o.status,
    totalUSD: o.totalUSD,
    totalCDF: o.totalCDF,
    deliveryAddress: o.deliveryAddress,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    confirmedAt: o.confirmedAt,
    courierAssignedAt: o.courierAssignedAt,
    verifiedAt: o.verifiedAt,
    itemsCount: o._count.items,
    buyer: o.buyer,
    courier: o.courier,
    product: product ? { id: product.id, title: product.title, image: product.images[0] ?? null } : null,
    seller: product
      ? {
          id: product.seller.id,
          name: product.seller.name,
          phone: product.seller.phone,
          avatar: product.seller.avatar,
          shopName: product.seller.shop?.name ?? null,
        }
      : null,
  };
};

export async function getDashboard(req: AuthRequest, res: Response) {
  try {
    const now = new Date();
    const todayStart = startOfLocalDay(now);
    const weekStart = new Date(todayStart.getTime() - 6 * DAY_MS);
    const prevWeekStart = new Date(todayStart.getTime() - 13 * DAY_MS);

    const [
      ordersToday,
      ordersAwaitingVerification,
      activeSellers,
      revenue,
      ordersAwaitingSeller,
      shopsUnverified,
      attentionRows,
      verifiedRows,
      recentRows,
      shops,
      shopsTotal,
      individuals,
      individualsTotal,
      courierRows,
      couriersTotal,
      statusGroups,
      dailyOrders,
      dailyClients,
      categories,
      topSellers,
      peakHours,
    ] = await Promise.all([
      prisma.order.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.order.count({ where: { status: OrderStatus.CONFIRMED, verifiedAt: null } }),
      prisma.user.count({ where: { products: { some: { isSold: false } } } }),
      prisma.order.aggregate({ where: { status: OrderStatus.DELIVERED }, _sum: { totalUSD: true, totalCDF: true } }),
      prisma.order.count({ where: { status: OrderStatus.AWAITING_SELLER_CONFIRMATION } }),
      prisma.shop.count({ where: { verified: false } }),
      prisma.order.findMany({
        where: {
          OR: [
            { status: OrderStatus.AWAITING_SELLER_CONFIRMATION },
            { status: OrderStatus.CONFIRMED, verifiedAt: null },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 30,
        select: orderSelect,
      }),
      // Commandes déclarées vérifiées, en attente de paiement : elles restent visibles côté admin
      prisma.order.findMany({
        where: { status: OrderStatus.COURIER_VERIFIED, paidAt: null },
        orderBy: { updatedAt: 'desc' },
        take: 30,
        select: orderSelect,
      }),
      // Triées par dernière activité : une commande qui vient de changer de statut reste en haut de la liste
      prisma.order.findMany({ orderBy: { updatedAt: 'desc' }, take: 50, select: orderSelect }),
      prisma.shop.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          name: true,
          description: true,
          logo: true,
          verified: true,
          owner: { select: { id: true, name: true, phone: true, avatar: true } },
        },
      }),
      prisma.shop.count(),
      prisma.user.findMany({
        where: { shop: null, products: { some: {} } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, name: true, phone: true, avatar: true, createdAt: true },
      }),
      prisma.user.count({ where: { shop: null, products: { some: {} } } }),
      prisma.order.findMany({
        where: {
          courierId: { not: null },
          status: { in: [OrderStatus.CONFIRMED, OrderStatus.COURIER_VERIFIED, OrderStatus.SHIPPED] },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: orderSelect,
      }),
      prisma.user.count({ where: { role: 'COURIER' } }),
      prisma.order.groupBy({ by: ['status'], where: { createdAt: { gte: weekStart } }, _count: { _all: true } }),
      prisma.$queryRaw<{ day: string; orders: number; revenue: number }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS orders,
               COALESCE(SUM(CASE WHEN "status" = 'DELIVERED' THEN "totalUSD" ELSE 0 END), 0)::float AS revenue
        FROM "Order"
        WHERE "createdAt" >= ${prevWeekStart}
        GROUP BY 1`,
      prisma.$queryRaw<{ day: string; clients: number }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS clients
        FROM "User"
        WHERE "role" = 'USER' AND "createdAt" >= ${prevWeekStart}
        GROUP BY 1`,
      prisma.$queryRaw<{ id: string; name: string; quantity: number }[]>`
        SELECT c."id", c."name", COALESCE(SUM(oi."quantity"), 0)::int AS quantity
        FROM "OrderItem" oi
        JOIN "Order" o ON o."id" = oi."orderId"
        JOIN "Product" p ON p."id" = oi."productId"
        JOIN "Category" c ON c."id" = p."categoryId"
        WHERE o."createdAt" >= ${weekStart} AND o."status" NOT IN ('CANCELLED', 'EXPIRED')
        GROUP BY c."id", c."name"
        ORDER BY quantity DESC
        LIMIT 6`,
      prisma.$queryRaw<{ id: string; name: string; orders: number }[]>`
        SELECT u."id", u."name", COUNT(DISTINCT o."id")::int AS orders
        FROM "Order" o
        JOIN "OrderItem" oi ON oi."orderId" = o."id"
        JOIN "Product" p ON p."id" = oi."productId"
        JOIN "User" u ON u."id" = p."sellerId"
        WHERE o."createdAt" >= ${weekStart} AND o."status" = 'DELIVERED'
        GROUP BY u."id", u."name"
        ORDER BY orders DESC
        LIMIT 5`,
      prisma.$queryRaw<{ hour: number; orders: number }[]>`
        SELECT EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::int AS hour,
               COUNT(*)::int AS orders
        FROM "Order"
        WHERE "createdAt" >= ${weekStart}
        GROUP BY 1`,
    ]);

    // Notes et stock disponible des vendeurs affichés (2 requêtes groupées, pas de N+1)
    const sellerIds = [...shops.map((s) => s.owner.id), ...individuals.map((u) => u.id)];
    const [ratings, available] = await Promise.all([
      prisma.sellerReview.groupBy({
        by: ['sellerId'],
        where: { sellerId: { in: sellerIds } },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      prisma.product.groupBy({
        by: ['sellerId'],
        where: { sellerId: { in: sellerIds }, isSold: false },
        _count: { _all: true },
      }),
    ]);
    const ratingMap = new Map(ratings.map((r) => [r.sellerId, { avg: r._avg.rating, count: r._count._all }]));
    const availableMap = new Map(available.map((a) => [a.sellerId, a._count._all]));
    const sellerStats = (id: string) => ({
      rating: ratingMap.get(id)?.avg ?? null,
      reviewsCount: ratingMap.get(id)?.count ?? 0,
      availableProducts: availableMap.get(id) ?? 0,
    });

    // Séries journalières (14 derniers jours locaux : 7 précédents + 7 courants)
    const keys = Array.from({ length: 14 }, (_, i) =>
      dayKey(new Date(todayStart.getTime() + 12 * 60 * 60 * 1000 - (13 - i) * DAY_MS)),
    );
    const ordersByDay = new Map(dailyOrders.map((r) => [r.day, r]));
    const clientsByDay = new Map(dailyClients.map((r) => [r.day, r.clients]));
    const ordersSeries = keys.map((k) => ordersByDay.get(k)?.orders ?? 0);
    const revenueSeries = keys.map((k) => ordersByDay.get(k)?.revenue ?? 0);
    const clientsSeries = keys.map((k) => clientsByDay.get(k) ?? 0);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const metric = (series: number[]) => {
      const cur = sum(series.slice(7));
      const prev = sum(series.slice(0, 7));
      return { total: cur, previous: prev, deltaPct: pct(cur, prev), series: series.slice(7) };
    };

    const statusCounts = new Map(statusGroups.map((g) => [g.status, g._count._all]));
    const hoursMap = new Map(peakHours.map((h) => [h.hour, h.orders]));

    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: {
        generatedAt: now,
        viewer: { name: req.user!.name, role: req.user!.role },
        badges: { ordersAwaitingSeller, shopsUnverified },
        kpis: {
          ordersToday,
          ordersAwaitingVerification,
          activeSellers,
          totalRevenueUSD: revenue._sum.totalUSD ?? 0,
          totalRevenueCDF: revenue._sum.totalCDF ?? 0,
        },
        attentionOrders: attentionRows.map(toOrderDto),
        verifiedOrders: verifiedRows.map(toOrderDto),
        recentOrders: recentRows.map(toOrderDto),
        shops: {
          total: shopsTotal,
          items: shops.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            logo: s.logo,
            verified: s.verified,
            owner: s.owner,
            ...sellerStats(s.owner.id),
          })),
        },
        individualSellers: {
          total: individualsTotal,
          items: individuals.map((u) => ({ ...u, ...sellerStats(u.id) })),
        },
        couriers: { total: couriersTotal, deliveries: courierRows.map(toOrderDto) },
        weekly: {
          days: keys.slice(7),
          orders: metric(ordersSeries),
          newClients: metric(clientsSeries),
          revenueUSD: metric(revenueSeries),
          statusDistribution: Object.values(OrderStatus).map((s) => ({ status: s, count: statusCounts.get(s) ?? 0 })),
          popularCategories: categories,
          topSellers,
          peakHours: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hoursMap.get(h) ?? 0 })),
        },
      },
    });
  } catch (err: any) {
    console.error('Erreur admin-seller dashboard:', err?.message || err);
    return res
      .status(500)
      .json({ success: false, error: 'Erreur serveur.', message: 'Erreur serveur.' });
  }
}


// ==========================================
// PATCH /api/admin-seller/orders/:id/status
// ==========================================
// Changements de statut manuels autorisés pour un administrateur.
// SHIPPED et DELIVERED sont volontairement absents : ils sont posés par le paiement confirmé et par la
// livraison (versement au vendeur), jamais à la main. EXPIRED est posé automatiquement par le délai de 12h.
const ADMIN_TRANSITIONS: Record<'COURIER_VERIFIED' | 'CANCELLED', OrderStatus[]> = {
  COURIER_VERIFIED: [OrderStatus.CONFIRMED],
  CANCELLED: [
    OrderStatus.PENDING,
    OrderStatus.AWAITING_SELLER_CONFIRMATION,
    OrderStatus.CONFIRMED,
    OrderStatus.COURIER_VERIFIED,
  ],
};

const orderIdSchema = z.string().min(10).max(40).regex(/^[a-z0-9]+$/i);
const updateStatusSchema = z
  .object({
    status: z.enum(['COURIER_VERIFIED', 'CANCELLED']),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export async function updateOrderStatus(req: AuthRequest, res: Response) {
  try {
    const idParsed = orderIdSchema.safeParse(req.params.id);
    if (!idParsed.success) return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    const parsed = updateStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ success: false, message: 'Requête invalide.' });

    const orderId = idParsed.data;
    const { status: target, note } = parsed.data;
    const admin = req.user!;

    // Verrou sur la commande : le paiement et ce changement de statut ne peuvent pas se croiser.
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;

        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            status: true,
            paidAt: true,
            buyerId: true,
            verificationNote: true,
            items: { select: { product: { select: { title: true, isSold: true, sellerId: true } } } },
          },
        });
        if (!order) return { kind: 'not_found' as const };
        if (order.paidAt) return { kind: 'paid' as const };
        if (!ADMIN_TRANSITIONS[target].includes(order.status)) return { kind: 'bad_transition' as const };

        if (target === 'COURIER_VERIFIED' && (order.items.length === 0 || order.items.some((it) => it.product.isSold))) {
          return { kind: 'unavailable' as const };
        }
        if (target === 'CANCELLED') {
          const activePayment = await tx.payment.findFirst({
            where: { orderId, status: { in: ['PENDING', 'SUCCESS'] } },
            select: { id: true },
          });
          if (activePayment) return { kind: 'payment_active' as const };
        }

        const now = new Date();
        const adminNote = `[Admin ${admin.name}] ${note || 'Vérification validée depuis le tableau de bord.'}`;
        const data: Prisma.OrderUpdateManyMutationInput =
          target === 'COURIER_VERIFIED'
            ? {
                status: OrderStatus.COURIER_VERIFIED,
                verifiedAt: now,
                verificationNote: order.verificationNote ? `${order.verificationNote}\n${adminNote}` : adminNote,
              }
            : { status: OrderStatus.CANCELLED };

        // La condition sur l'ancien statut et paidAt garantit qu'aucune autre écriture n'est écrasée.
        const updated = await tx.order.updateMany({
          where: { id: orderId, paidAt: null, status: order.status },
          data,
        });
        if (updated.count !== 1) return { kind: 'bad_transition' as const };

        return {
          kind: 'ok' as const,
          from: order.status,
          buyerId: order.buyerId,
          sellerIds: [...new Set(order.items.map((it) => it.product.sellerId))],
          productTitle: order.items[0]?.product.title ?? 'votre article',
        };
      },
      { timeout: 10_000 },
    );

    switch (result.kind) {
      case 'not_found':
        return res.status(404).json({ success: false, message: 'Commande introuvable.' });
      case 'paid':
        return res.status(409).json({ success: false, message: 'Cette commande est déjà payée : son statut ne peut plus être modifié ici.' });
      case 'bad_transition':
        return res.status(409).json({ success: false, message: "Ce changement de statut n'est pas autorisé pour l'état actuel de la commande." });
      case 'unavailable':
        return res.status(409).json({ success: false, message: "Un article de cette commande n'est plus disponible." });
      case 'payment_active':
        return res.status(409).json({ success: false, message: 'Un paiement est en cours ou confirmé pour cette commande : annulation impossible.' });
    }

    // Journal d'audit : qui a changé quoi, et quand.
    console.info(
      JSON.stringify({
        event: 'admin_order_status_changed',
        adminId: admin.id,
        orderId,
        from: result.from,
        to: target,
        at: new Date().toISOString(),
      }),
    );

    // Notifications : au mieux, un échec ici n'annule pas le changement de statut.
    try {
      const notifications =
        target === 'COURIER_VERIFIED'
          ? [
              {
                userId: result.buyerId,
                title: 'Commande vérifiée',
                message: `Votre article « ${result.productTitle} » a été vérifié. Vous pouvez maintenant payer votre commande.`,
              },
            ]
          : [
              {
                userId: result.buyerId,
                title: 'Commande annulée',
                message: `Votre commande « ${result.productTitle} » a été annulée par l'administration. Contactez le support pour plus d'informations.`,
              },
              ...result.sellerIds
                .filter((id) => id !== result.buyerId)
                .map((id) => ({
                  userId: id,
                  title: 'Commande annulée',
                  message: `Une commande portant sur « ${result.productTitle} » a été annulée par l'administration.`,
                })),
            ];
      await prisma.notification.createMany({ data: notifications });
    } catch (e: any) {
      console.error('Notification changement de statut:', e?.message || e);
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: { id: orderId, status: target } });
  } catch (err: any) {
    console.error('Erreur admin-seller updateOrderStatus:', err?.message || err);
    return res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
}