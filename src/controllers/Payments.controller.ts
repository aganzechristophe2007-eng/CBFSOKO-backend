import { Request, Response } from 'express';
import { z } from 'zod';
import { Payment } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { calculateDeliveryFeeCDF, cdfToUsd, PLATFORM_COMMISSION_RATE } from './orders.controller';
import {
  WonyaPayError,
  ProviderStatus,
  buildCallbackUrl,
  generateRefTransa,
  getTransactionStatus,
  initiateC2B,
  isValidCallbackSecret,
  isWonyaPayConfigured,
  mapProviderStatus,
  maskMobileNumber,
  normalizeMobileNumber,
} from '../services/wonyapay.service';

// ==========================================
// PAIEMENT WONYAPAY — principes de sécurité
//  1. Le montant est TOUJOURS recalculé ici à partir de la commande en base. Le navigateur n'envoie
//     que la devise, le numéro Mobile Money et l'adresse de livraison.
//  2. Un paiement n'est validé que si WonyaPay confirme son état quand NOUS l'interrogeons avec notre
//     token (GET /transaction-status). Le callback, qui n'est pas signé, sert uniquement de signal :
//     un faux callback ne peut rien valider.
//  3. Idempotence : la validation est une opération atomique unique. Un callback reçu deux fois, ou en
//     même temps que le rattrapage périodique, ne paie jamais la commande deux fois.
//  4. Un seul paiement en cours par commande (verrou en base), pour éviter les doubles débits.
//  5. Si de l'argent est encaissé alors que la commande n'est plus payable, le paiement est marqué
//     « refundRequired » et journalisé pour un remboursement manuel.
// ==========================================

const EXPIRY_MS = 10 * 60 * 1000; // sans confirmation de l'acheteur au bout de 10 min : EXPIRED
const NOT_FOUND_GRACE_MS = 90 * 1000; // WonyaPay ne connaît pas la référence après 90 s : la demande n'est jamais partie
const LATE_WINDOW_MS = 24 * 60 * 60 * 1000; // un paiement EXPIRED reste surveillé 24 h (paiement tardif)
const MIN_RECHECK_MS = 3 * 1000;
const SWEEP_BATCH = 50;

const UNAVAILABLE_MESSAGE = 'Le paiement est momentanément indisponible. Réessayez dans quelques minutes.';

const orderIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);

const initiateSchema = z.object({
  currency: z
    .string()
    .refine((v) => v === 'CDF' || v === 'USD', 'Devise invalide (CDF ou USD).')
    .transform((v) => v as 'CDF' | 'USD'),
  phone: z.string().min(9, 'Numéro Mobile Money invalide.').max(20, 'Numéro Mobile Money invalide.'),
  address: z
    .string()
    .trim()
    .min(10, "Indiquez une adresse de livraison précise (commune, quartier, avenue, numéro).")
    .max(300, 'Adresse trop longue (300 caractères maximum).'),
});

// Ce que le frontend a le droit de voir d'un paiement.
const toPublic = (p: Payment) => ({
  id: p.id,
  orderId: p.orderId,
  status: p.status,
  amount: p.amount,
  currency: p.currency,
  feeAmount: p.feeAmount,
  totalCharged: p.totalCharged,
  network: p.network,
  phoneMasked: p.phoneMasked,
  failureCode: p.failureCode,
  createdAt: p.createdAt,
});

// Même calcul que getOrderPaymentSummary (orders.controller.ts), avec les mêmes fonctions de base :
// livraison selon le poids, commission de la plateforme, conversion USD au taux de cette commande.
function computeGrandTotals(order: {
  totalUSD: number;
  totalCDF: number;
  items: { quantity: number; product: { weight: number | null } }[];
}) {
  const quantity = order.items.reduce((sum, it) => sum + it.quantity, 0);
  const deliveryFeeCDF = calculateDeliveryFeeCDF(order.items[0]?.product.weight ?? null, quantity);
  const commissionCDF = Math.round(order.totalCDF * PLATFORM_COMMISSION_RATE);
  const grandTotalCDF = order.totalCDF + deliveryFeeCDF + commissionCDF;
  return { grandTotalCDF, grandTotalUSD: cdfToUsd(grandTotalCDF, order) };
}

// ==========================================
// POST /api/payments/orders/:orderId/initiate
// ==========================================
export async function initiatePayment(req: AuthRequest, res: Response) {
  try {
    if (!isWonyaPayConfigured()) {
      console.error('[WonyaPay] Configuration incomplète (WONYAPAY_TOKEN, WONYAPAY_PARTNER_ID, WONYAPAY_CALLBACK_SECRET, PUBLIC_API_URL).');
      return res.status(503).json({ success: false, message: UNAVAILABLE_MESSAGE });
    }

    const userId = req.user!.id;
    const orderIdParsed = orderIdSchema.safeParse(req.params.orderId);
    if (!orderIdParsed.success) return res.status(404).json({ success: false, message: 'Commande introuvable' });
    const orderId = orderIdParsed.data;

    const parsed = initiateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'Requête invalide' });
    }
    const { currency, address } = parsed.data;
    const phone = normalizeMobileNumber(parsed.data.phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Numéro Mobile Money invalide (10 chiffres, ex. 0997654321).' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        buyerId: true,
        status: true,
        paidAt: true,
        totalUSD: true,
        totalCDF: true,
        items: { select: { quantity: true, product: { select: { id: true, title: true, isSold: true, weight: true } } } },
      },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });
    if (order.buyerId !== userId) return res.status(403).json({ success: false, message: 'Accès refusé' });
    if (order.paidAt) return res.status(409).json({ success: false, message: 'Cette commande est déjà payée.' });
    if (order.status !== 'COURIER_VERIFIED') {
      return res.status(409).json({ success: false, message: "Cette commande n'est pas encore prête pour le paiement." });
    }
    if (order.items.length === 0 || order.items.some((it) => it.product.isSold)) {
      return res.status(409).json({ success: false, message: "Cet article n'est plus disponible." });
    }

    // Montant calculé uniquement ici, jamais reçu du navigateur.
    const totals = computeGrandTotals(order);
    const amount = currency === 'CDF' ? Math.round(totals.grandTotalCDF) : Math.round(totals.grandTotalUSD * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error(`[Paiement] Montant invalide pour la commande ${orderId} : ${amount} ${currency}`);
      return res.status(409).json({ success: false, message: 'Montant de la commande invalide.' });
    }

    // Verrou sur la commande : deux demandes simultanées ne peuvent pas créer deux paiements.
    const prepared = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;

        const fresh = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, paidAt: true } });
        if (!fresh || fresh.paidAt || fresh.status !== 'COURIER_VERIFIED') return { kind: 'not_payable' as const };

        const inProgress = await tx.payment.findFirst({
          where: { orderId, status: 'PENDING', createdAt: { gte: new Date(Date.now() - EXPIRY_MS) } },
          orderBy: { createdAt: 'desc' },
        });
        if (inProgress) return { kind: 'in_progress' as const, payment: inProgress };

        await tx.order.update({ where: { id: orderId }, data: { deliveryAddress: address } });
        const payment = await tx.payment.create({
          data: {
            orderId,
            userId,
            refTransa: generateRefTransa(),
            amount,
            currency,
            phoneMasked: maskMobileNumber(phone),
          },
        });
        return { kind: 'created' as const, payment };
      },
      { timeout: 10_000 }
    );

    if (prepared.kind === 'not_payable') {
      return res.status(409).json({ success: false, message: "Cette commande n'est plus payable." });
    }
    if (prepared.kind === 'in_progress') {
      return res.status(409).json({
        success: false,
        code: 'PAYMENT_IN_PROGRESS',
        paymentId: prepared.payment.id,
        message: 'Un paiement est déjà en cours pour cette commande.',
      });
    }

    const payment = prepared.payment;
    const productTitle = order.items[0].product.title;

    try {
      const result = await initiateC2B({
        refTransa: payment.refTransa,
        amount: payment.amount,
        currency,
        phone,
        motif: `CBFSOKO - ${productTitle}`,
        callbackUrl: buildCallbackUrl(),
        extra: { paymentId: payment.id, orderId },
      });

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerTransactionId: result.providerTransactionId,
          feeAmount: result.feeAmount,
          totalCharged: result.totalCharged,
          network: result.network,
        },
      });
      return res.status(201).json({ success: true, data: toPublic(updated) });
    } catch (err) {
      if (!(err instanceof WonyaPayError)) throw err;

      // Résultat incertain (délai dépassé, erreur 500, doublon de référence) : la demande est peut-être
      // partie. On garde le paiement « en attente » ; la vérification auprès de WonyaPay tranchera.
      if (!err.definitive) {
        console.warn(`[WonyaPay] Initiation incertaine (${err.kind}) pour le paiement ${payment.id} : ${err.message}`);
        return res.status(202).json({
          success: true,
          data: toPublic(payment),
          notice: 'Vérification de votre paiement en cours.',
        });
      }

      await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED', failureCode: err.kind === 'invalid' ? 'REFUSED' : 'PROVIDER_ERROR', lastCheckedAt: new Date() },
      });

      if (err.kind === 'auth' || err.kind === 'config') {
        console.error(`[WonyaPay][CRITIQUE] ${err.message} — vérifiez WONYAPAY_TOKEN et WONYAPAY_PARTNER_ID.`);
        return res.status(503).json({ success: false, message: UNAVAILABLE_MESSAGE });
      }
      if (err.kind === 'invalid') {
        console.warn(`[WonyaPay] Demande refusée pour le paiement ${payment.id} : ${err.message}`);
        return res.status(422).json({
          success: false,
          message: 'Le paiement a été refusé. Vérifiez votre numéro Mobile Money (réseau pris en charge) puis réessayez.',
        });
      }
      return res.status(502).json({ success: false, message: UNAVAILABLE_MESSAGE });
    }
  } catch (err) {
    console.error('Erreur initiatePayment:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// ==========================================
// Vérification auprès de WonyaPay (cœur de la sécurité)
// ==========================================
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.01;

async function markTerminal(paymentId: string, status: 'FAILED' | 'EXPIRED', failureCode: string) {
  await prisma.payment.updateMany({
    where: { id: paymentId, status: { in: status === 'FAILED' ? ['PENDING', 'EXPIRED'] : ['PENDING'] } },
    data: { status, failureCode, lastCheckedAt: new Date() },
  });
}

async function touch(paymentId: string) {
  await prisma.payment.updateMany({ where: { id: paymentId }, data: { lastCheckedAt: new Date() } });
}

// Valide le paiement et la commande en une seule transaction atomique.
async function confirmPayment(payment: Payment): Promise<'confirmed' | 'already' | 'refund_required'> {
  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    // « Réclamation » atomique : un seul appel (callback, sondage ou rattrapage) peut passer ici.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ['PENDING', 'EXPIRED'] } },
      data: { status: 'SUCCESS', confirmedAt: now, lastCheckedAt: now, failureCode: null },
    });
    if (claimed.count === 0) return 'already' as const;

    const orderUpdate = await tx.order.updateMany({
      where: { id: payment.orderId, paidAt: null, status: 'COURIER_VERIFIED' },
      data: { paidAt: now, status: 'SHIPPED' },
    });
    if (orderUpdate.count === 0) {
      // L'argent est encaissé mais la commande est déjà payée ou n'est plus payable.
      await tx.payment.update({ where: { id: payment.id }, data: { refundRequired: true, failureCode: 'ORDER_NOT_PAYABLE' } });
      return 'refund_required' as const;
    }

    await tx.transaction.create({
      data: {
        userId: payment.userId,
        type: 'PAYMENT',
        amount: payment.amount,
        currency: payment.currency,
        status: 'COMPLETED',
        reference: payment.refTransa,
      },
    });

    const order = await tx.order.findUnique({
      where: { id: payment.orderId },
      select: {
        buyerId: true,
        courierId: true,
        items: { select: { productId: true, product: { select: { title: true, sellerId: true } } } },
      },
    });
    if (order) {
      const title = order.items[0]?.product.title ?? 'votre article';
      const notifications = [
        {
          userId: order.buyerId,
          title: 'Paiement confirmé',
          message: `Votre paiement pour "${title}" est confirmé. Votre commande est en cours de livraison.`,
        },
        ...Array.from(new Set(order.items.map((it) => it.product.sellerId))).map((sellerId) => ({
          userId: sellerId,
          title: 'Article payé',
          message: `"${title}" a été payé. CBFSOKO organise la livraison.`,
        })),
        ...(order.courierId
          ? [{ userId: order.courierId, title: 'Commande payée', message: `La commande "${title}" est payée : vous pouvez la livrer.` }]
          : []),
      ];
      await tx.notification.createMany({ data: notifications });

      // Article à l'unité : il est vendu. (Les annonces à plusieurs exemplaires restent disponibles.)
      await tx.product.updateMany({
        where: { id: { in: order.items.map((it) => it.productId) }, quantity: { lte: 1 } },
        data: { isSold: true },
      });
    }
    return 'confirmed' as const;
  });

  if (outcome === 'refund_required') {
    console.error(
      `[Paiement][REMBOURSEMENT REQUIS] Paiement ${payment.id} (${payment.refTransa}, ${payment.amount} ${payment.currency}) encaissé mais la commande ${payment.orderId} n'est plus payable.`
    );
  }
  return outcome;
}

function matchesPayment(payment: Payment, st: ProviderStatus): boolean {
  if (st.refTransa && st.refTransa !== payment.refTransa) return false;
  if (st.devise && st.devise !== payment.currency) return false;
  if (st.amount !== null && !sameAmount(st.amount, payment.amount)) return false;
  if (st.transactionId && payment.providerTransactionId && st.transactionId !== payment.providerTransactionId) return false;
  return true;
}

// Redemande à WonyaPay l'état réel du paiement et met la base à jour. Utilisée par le callback, par la
// page de paiement (sondage) et par le rattrapage périodique. Sûre à appeler plusieurs fois.
export async function reconcilePayment(paymentId: string, opts: { force?: boolean } = {}): Promise<Payment | null> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return null;
  if (payment.status === 'SUCCESS' || payment.status === 'FAILED') return payment;
  if (!opts.force && payment.lastCheckedAt && Date.now() - payment.lastCheckedAt.getTime() < MIN_RECHECK_MS) return payment;

  const ageMs = Date.now() - payment.createdAt.getTime();

  let st: ProviderStatus;
  try {
    st = await getTransactionStatus(payment.refTransa);
  } catch (err: any) {
    console.error(`[WonyaPay] Vérification impossible pour ${payment.id} :`, err?.message || err);
    await touch(payment.id);
    return prisma.payment.findUnique({ where: { id: payment.id } });
  }

  if (!st.found) {
    if (payment.status === 'PENDING' && ageMs > NOT_FOUND_GRACE_MS) await markTerminal(payment.id, 'FAILED', 'NOT_FOUND');
    else await touch(payment.id);
    return prisma.payment.findUnique({ where: { id: payment.id } });
  }

  const mapped = mapProviderStatus(st.rawStatus);
  const consistent = matchesPayment(payment, st);

  if (mapped === 'SUCCESS') {
    if (!consistent) {
      // WonyaPay annonce un succès dont le montant, la devise ou l'identifiant ne correspondent pas : on ne
      // valide JAMAIS la commande, et on signale pour vérification manuelle.
      console.error(
        `[SÉCURITÉ] Succès incohérent pour le paiement ${payment.id} : attendu ${payment.amount} ${payment.currency} / ${payment.providerTransactionId}, reçu ${st.amount} ${st.devise} / ${st.transactionId}`
      );
      await prisma.payment.updateMany({
        where: { id: payment.id, status: { in: ['PENDING', 'EXPIRED'] } },
        data: { status: 'FAILED', failureCode: 'AMOUNT_MISMATCH', refundRequired: true, lastCheckedAt: new Date() },
      });
    } else {
      await confirmPayment(payment);
    }
  } else if (mapped === 'FAILED') {
    if (consistent) await markTerminal(payment.id, 'FAILED', 'DECLINED');
    else await touch(payment.id);
  } else if (payment.status === 'PENDING' && ageMs > EXPIRY_MS) {
    await markTerminal(payment.id, 'EXPIRED', 'EXPIRED');
  } else {
    await touch(payment.id);
  }

  return prisma.payment.findUnique({ where: { id: payment.id } });
}

// ==========================================
// POST /api/payments/callback/wonyapay/:secret — appelé par WonyaPay (sans cookie de session)
// Le contenu n'est PAS cru : il sert uniquement à savoir quel paiement revérifier.
// On répond 200 aussitôt (WonyaPay attend moins de 30 s et coupe son envoi après des échecs répétés) ;
// le rattrapage périodique et le sondage de la page couvrent tout échec de vérification.
// ==========================================
export async function wonyapayCallback(req: Request, res: Response) {
  if (!isValidCallbackSecret(String(req.params.secret ?? ''))) {
    return res.status(404).json({ success: false });
  }

  // Liste blanche d'adresses IP facultative : WONYAPAY_CALLBACK_IPS="1.2.3.4,5.6.7.8"
  const allowedIps = (process.env.WONYAPAY_CALLBACK_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowedIps.length > 0 && !allowedIps.includes(String(req.ip ?? ''))) {
    console.warn(`[WonyaPay] Callback refusé : IP non autorisée (${req.ip}).`);
    return res.status(403).json({ success: false });
  }

  res.status(200).json({ received: true });

  try {
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const paymentId = typeof body.paymentId === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(body.paymentId) ? body.paymentId : null;
    const providerId = typeof body.Id === 'string' && body.Id.length <= 80 ? body.Id : null;
    console.log(`[WonyaPay] Callback reçu : paymentId=${paymentId} Id=${providerId} StatutWonya=${String(body.StatutWonya ?? '').slice(0, 20)}`);

    let payment: Payment | null = null;
    if (paymentId) payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment && providerId) payment = await prisma.payment.findFirst({ where: { providerTransactionId: providerId } });
    if (!payment) return;

    await reconcilePayment(payment.id, { force: true });
  } catch (err) {
    console.error('Erreur wonyapayCallback:', err);
  }
}

// ==========================================
// GET /api/payments/:id — état d'un paiement (sondage de la page de paiement)
// ==========================================
export async function getPayment(req: AuthRequest, res: Response) {
  try {
    const idParsed = orderIdSchema.safeParse(req.params.id);
    if (!idParsed.success) return res.status(404).json({ success: false, message: 'Paiement introuvable' });

    const payment = await prisma.payment.findUnique({ where: { id: idParsed.data } });
    // Même réponse qu'il n'existe pas ou qu'il appartienne à un autre : rien n'est révélé.
    if (!payment || payment.userId !== req.user!.id) return res.status(404).json({ success: false, message: 'Paiement introuvable' });

    let current: Payment = payment;
    if (payment.status === 'PENDING') current = (await reconcilePayment(payment.id)) ?? payment;

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: toPublic(current) });
  } catch (err) {
    console.error('Erreur getPayment:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// ==========================================
// GET /api/payments/orders/:orderId/latest — dernier paiement de la commande (reprise après rechargement)
// ==========================================
export async function getLatestPaymentForOrder(req: AuthRequest, res: Response) {
  try {
    const idParsed = orderIdSchema.safeParse(req.params.orderId);
    if (!idParsed.success) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    const order = await prisma.order.findUnique({ where: { id: idParsed.data }, select: { buyerId: true } });
    if (!order || order.buyerId !== req.user!.id) return res.status(404).json({ success: false, message: 'Commande introuvable' });

    const latest = await prisma.payment.findFirst({ where: { orderId: idParsed.data }, orderBy: { createdAt: 'desc' } });
    let current: Payment | null = latest;
    if (latest && latest.status === 'PENDING') current = (await reconcilePayment(latest.id)) ?? latest;

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: current ? toPublic(current) : null });
  } catch (err) {
    console.error('Erreur getLatestPaymentForOrder:', err);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
}

// ==========================================
// Rattrapage périodique (appelé depuis server.ts toutes les 30 s)
// ==========================================
export async function sweepPendingPayments() {
  if (!isWonyaPayConfigured()) return;
  const now = Date.now();

  const candidates = await prisma.payment.findMany({
    where: {
      OR: [
        {
          status: 'PENDING',
          createdAt: { lte: new Date(now - 20_000) },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now - 10_000) } }],
        },
        {
          status: 'EXPIRED',
          createdAt: { gte: new Date(now - LATE_WINDOW_MS) },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now - 5 * 60_000) } }],
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
    select: { id: true },
  });

  for (const { id } of candidates) {
    try {
      await reconcilePayment(id, { force: true });
    } catch (err) {
      console.error(`Erreur rattrapage paiement ${id}:`, err);
    }
  }
}