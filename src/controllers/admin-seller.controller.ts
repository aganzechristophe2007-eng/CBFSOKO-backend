import { Response } from 'express';
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
      prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 30, select: orderSelect }),
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
