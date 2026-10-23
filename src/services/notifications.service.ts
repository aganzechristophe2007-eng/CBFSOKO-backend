import type { PrismaClient } from '@prisma/client';
import webpush from 'web-push';

/**
 * Service de notifications : enregistrement en base (dédoublonné), envoi push (Web Push / VAPID)
 * et génération automatique des notifications (nouveau produit d'un vendeur suivi,
 * changement de statut d'une commande).
 *
 * Le push n'est actif que si VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY et VAPID_SUBJECT sont définis.
 * Sinon les notifications restent disponibles dans l'application (page Notifications).
 */

export type NotificationType = 'SYSTEM' | 'ORDER' | 'PRODUCT' | 'COMMENT' | 'MESSAGE' | 'PAYMENT';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  /** Chemin interne du site (ex. /products/abc). Toute autre valeur est ignorée. */
  link?: string | null;
  /** Clé d'unicité : une même clé ne crée jamais deux notifications. */
  dedupeKey?: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export type NotificationService = ReturnType<typeof createNotificationService>;

const clip = (value: string, max: number): string => String(value).trim().slice(0, max);

// Un lien de notification doit rester interne : "/..." mais jamais "//..." (redirection externe).
const safeLink = (link?: string | null): string | null => {
  if (!link || typeof link !== 'string') return null;
  if (!link.startsWith('/') || link.startsWith('//')) return null;
  return link.slice(0, 300);
};

async function inChunks<T>(items: T[], size: number, worker: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker));
  }
}

export function createNotificationService(prisma: PrismaClient) {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || '').trim();

  let pushEnabled = false;
  if (publicKey && privateKey && subject) {
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      pushEnabled = true;
    } catch (error) {
      console.error('[push] Clés VAPID invalides, notifications push désactivées :', (error as Error).message);
    }
  } else {
    console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT absents : notifications push désactivées (les notifications dans l\'application restent actives).');
  }

  /** Envoie un push à tous les appareils abonnés d'un utilisateur. Retourne le nombre d'envois acceptés. */
  const sendPush = async (userId: string, payload: PushPayload): Promise<number> => {
    if (!pushEnabled) return 0;
    const subscriptions = await prisma.pushSubscription.findMany({ where: { userId }, take: 20 });
    let delivered = 0;
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 60 * 12 }
          );
          delivered += 1;
        } catch (error: any) {
          const status = error?.statusCode;
          if (status === 404 || status === 410) {
            // Abonnement expiré ou révoqué côté navigateur : on le retire.
            await prisma.pushSubscription.deleteMany({ where: { id: sub.id } }).catch(() => undefined);
          } else {
            console.error('[push] Envoi échoué', status || error?.message);
          }
        }
      })
    );
    return delivered;
  };

  /** Crée une notification (sans doublon) puis tente le push. */
  const create = async (input: NotifyInput): Promise<{ created: boolean; pushed: number }> => {
    try {
      const notification = await prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: clip(input.title, 120),
          message: clip(input.message, 400),
          link: safeLink(input.link),
          dedupeKey: input.dedupeKey ?? null,
        },
      });
      const pushed = await sendPush(input.userId, {
        title: notification.title,
        body: notification.message,
        url: notification.link || '/notifications',
        tag: notification.dedupeKey || notification.id,
      });
      return { created: true, pushed };
    } catch (error: any) {
      if (error?.code === 'P2002') return { created: false, pushed: 0 }; // doublon : déjà notifié
      console.error('[notifications] Création impossible :', error?.message || error);
      return { created: false, pushed: 0 };
    }
  };

  /** Un vendeur publie un produit : prévient ses abonnés (table Follow). */
  const notifyFollowersOfNewProduct = async (args: {
    sellerId: string;
    sellerName: string;
    productId: string;
    title: string;
    isRequest?: boolean;
  }): Promise<number> => {
    const followers = await prisma.follow.findMany({
      where: { followingId: args.sellerId },
      select: { followerId: true },
      take: 1000,
    });
    let created = 0;
    await inChunks(followers, 10, async (f) => {
      const result = await create({
        userId: f.followerId,
        type: 'PRODUCT',
        title: args.isRequest ? 'Nouvelle demande publiée' : 'Nouveau produit',
        message: `${args.sellerName} a publié « ${clip(args.title, 80)} ».`,
        link: `/products/${args.productId}`,
        dedupeKey: `product:${args.productId}:${f.followerId}`,
      });
      if (result.created) created += 1;
    });
    return created;
  };

  const ORDER_WINDOW_MS = 30 * 60 * 1000;

  /**
   * Rattrape les changements de statut de commande récents et crée les notifications
   * correspondantes. Indépendant du contrôleur des commandes : chaque couple
   * (commande, statut, destinataire) n'est notifié qu'une fois grâce à dedupeKey.
   */
  const sweepOrderNotifications = async (): Promise<void> => {
    const since = new Date(Date.now() - ORDER_WINDOW_MS);
    const orders = await prisma.order.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        status: true,
        buyerId: true,
        sellerId: true,
        items: { take: 1, select: { product: { select: { title: true } } } },
      },
    });

    for (const order of orders) {
      const label = order.items[0]?.product?.title ? `« ${clip(order.items[0].product.title, 60)} »` : 'votre commande';
      const jobs: { userId: string; role: 'buyer' | 'seller'; title: string; message: string }[] = [];

      switch (order.status) {
        case 'AWAITING_SELLER_CONFIRMATION':
          if (order.sellerId) jobs.push({ userId: order.sellerId, role: 'seller', title: 'Nouvelle demande de livraison', message: `Un acheteur souhaite se faire livrer ${label}. Confirmez la disponibilité rapidement.` });
          break;
        case 'CONFIRMED':
          jobs.push({ userId: order.buyerId, role: 'buyer', title: 'Commande confirmée', message: `Le vendeur a confirmé ${label}. Un livreur va passer récupérer l'article.` });
          break;
        case 'COURIER_VERIFIED':
          jobs.push({ userId: order.buyerId, role: 'buyer', title: 'Article vérifié', message: `Le livreur a vérifié ${label}.` });
          break;
        case 'SHIPPED':
          jobs.push({ userId: order.buyerId, role: 'buyer', title: 'Commande en route', message: `${label} est en cours de livraison.` });
          break;
        case 'DELIVERED':
          jobs.push({ userId: order.buyerId, role: 'buyer', title: 'Livraison confirmée', message: `La livraison de ${label} est confirmée.` });
          if (order.sellerId) jobs.push({ userId: order.sellerId, role: 'seller', title: 'Livraison confirmée', message: `La livraison de ${label} est confirmée.` });
          break;
        case 'CANCELLED':
          jobs.push({ userId: order.buyerId, role: 'buyer', title: 'Commande annulée', message: `La commande ${label} a été annulée.` });
          if (order.sellerId) jobs.push({ userId: order.sellerId, role: 'seller', title: 'Commande annulée', message: `La commande ${label} a été annulée.` });
          break;
        case 'EXPIRED':
          jobs.push({ userId: order.buyerId, role: 'buyer', title: 'Demande expirée', message: `Le vendeur n'a pas répondu à temps pour ${label}.` });
          if (order.sellerId) jobs.push({ userId: order.sellerId, role: 'seller', title: 'Demande expirée', message: `Le délai de réponse pour ${label} est dépassé.` });
          break;
        default:
          break;
      }

      for (const job of jobs) {
        await create({
          userId: job.userId,
          type: 'ORDER',
          title: job.title,
          message: job.message,
          link: '/orders',
          dedupeKey: `order:${order.id}:${order.status}:${job.role}`,
        });
      }
    }
  };

  return {
    pushEnabled,
    publicKey: pushEnabled ? publicKey : null,
    create,
    sendPush,
    notifyFollowersOfNewProduct,
    sweepOrderNotifications,
  };
}
