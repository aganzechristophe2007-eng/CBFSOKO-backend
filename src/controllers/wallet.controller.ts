import { Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { WalletDeposit, WalletWithdrawal } from '@prisma/client';
import prisma from '../lib/prisma';
import { AuthRequest } from '../middleware/auth.middleware';
import { computeGrandTotals } from './payments.controller';
import {
  WonyaPayError,
  buildCallbackUrl,
  generateRefTransa,
  initiateC2B,
  isWonyaPayConfigured,
  maskMobileNumber,
  normalizeMobileNumber,
} from '../services/Wonyapay.service';
import {
  Currency,
  creditWallet,
  debitWallet,
  ensureWallet,
  failWithdrawal,
  formatAmount,
  lockWallet,
  reconcileDeposit,
  reconcileWithdrawal,
  roundMoney,
} from '../services/walletLedger.service';
import { PayoutError, initiatePayout, isPayoutConfigured } from '../services/wonyapayPayout.service';

// ==========================================
// PORTEFEUILLE — règles de sécurité
//  - Les montants et soldes sont toujours calculés et vérifiés ici ; le navigateur n'envoie que des intentions.
//  - Retrait et transfert exigent le mot de passe (un cookie volé ne suffit pas à vider un portefeuille).
//  - Un débit est conditionnel au solde, dans une transaction verrouillée : jamais de solde négatif.
//  - Un transfert porte une clé d'idempotence : un double clic ou un rejeu réseau ne débite qu'une fois.
//  - Le paiement d'une commande par portefeuille applique les mêmes contrôles que le paiement Mobile Money.
// ==========================================

// Limites par opération (ajuste-les selon ta politique).
const LIMITS: Record<Currency, { min: number; max: number }> = {
  CDF: { min: 100, max: 1_000_000 },
  USD: { min: 1, max: 500 },
};
const MAX_PENDING_WITHDRAWALS = 3;
const DEPOSIT_EXPIRY_MS = 10 * 60 * 1000;
const UNAVAILABLE_MESSAGE = 'Le service est momentanément indisponible. Réessayez dans quelques minutes.';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);

const currencySchema = z
  .string()
  .refine((v) => v === 'CDF' || v === 'USD', 'Devise invalide (CDF ou USD).')
  .transform((v) => v as Currency);

const amountSchema = z
  .number({ invalid_type_error: 'Montant invalide.', required_error: 'Montant requis.' })
  .finite('Montant invalide.')
  .positive('Montant invalide.');

const phoneSchema = z.string().min(9, 'Numéro Mobile Money invalide.').max(20, 'Numéro Mobile Money invalide.');
const passwordSchema = z.string().min(1, 'Mot de passe requis.').max(200);

const depositSchema = z.object({ currency: currencySchema, amount: amountSchema, phone: phoneSchema });
const withdrawSchema = z.object({ currency: currencySchema, amount: amountSchema, phone: phoneSchema, password: passwordSchema });
const transferSchema = z.object({
  currency: currencySchema,
  amount: amountSchema,
  toNumber: z.string().trim().regex(/^CBF-\d{8}$/, 'Numéro de portefeuille invalide.'),
  password: passwordSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Requête invalide.'),
});
const payOrderSchema = z.object({
  currency: currencySchema,
  address: z
    .string()
    .trim()
    .min(10, 'Indiquez une adresse de livraison précise (commune, quartier, avenue, numéro).')
    .max(300, 'Adresse trop longue (300 caractères maximum).'),
});

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function sendError(res: Response, err: unknown, tag: string) {
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
  console.error(`Erreur ${tag}:`, err);
  return res.status(500).json({ success: false, message: 'Erreur serveur' });
}

// CDF : entier. USD : 2 décimales au plus. Montant dans les bornes de l'opération.
function checkAmount(currency: Currency, raw: number): number {
  const amount = roundMoney(raw, currency);
  if (Math.abs(amount - raw) > 1e-9) {
    throw new HttpError(400, currency === 'CDF' ? 'Le montant en CDF doit être un nombre entier.' : 'Le montant en USD ne peut avoir que 2 décimales.');
  }
  const { min, max } = LIMITS[currency];
  if (amount < min) throw new HttpError(400, `Montant minimum : ${formatAmount(min, currency)}.`);
  if (amount > max) throw new HttpError(400, `Montant maximum par opération : ${formatAmount(max, currency)}.`);
  return amount;
}

async function verifyPassword(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  const ok = user ? await bcrypt.compare(password, user.password) : false;
  if (!ok) throw new HttpError(403, 'Mot de passe incorrect.');
}

// « Chris K. » : assez pour reconnaître le destinataire, sans exposer son nom complet.
function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Utilisateur';
  const first = parts[0].slice(0, 20);
  return parts[1] ? `${first} ${parts[1][0].toUpperCase()}.` : first;
}

const depositToPublic = (d: WalletDeposit) => ({
  id: d.id,
  status: d.status,
  amount: d.amount,
  currency: d.currency,
  feeAmount: d.feeAmount,
  totalCharged: d.totalCharged,
  network: d.network,
  phoneMasked: d.phoneMasked,
  failureCode: d.failureCode,
  createdAt: d.createdAt,
});

const withdrawalToPublic = (w: WalletWithdrawal) => ({
  id: w.id,
  status: w.status,
  amount: w.amount,
  currency: w.currency,
  phoneMasked: w.phoneMasked,
  failureCode: w.failureCode,
  createdAt: w.createdAt,
});

// ==========================================
// GET /api/wallet
// ==========================================
export async function getWallet(req: AuthRequest, res: Response) {
  try {
    const wallet = await ensureWallet(req.user!.id);
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: {
        number: wallet.number,
        balanceCDF: roundMoney(wallet.balanceCDF, 'CDF'),
        balanceUSD: roundMoney(wallet.balanceUSD, 'USD'),
        limits: LIMITS,
      },
    });
  } catch (err) {
    return sendError(res, err, 'getWallet');
  }
}

// ==========================================
// GET /api/wallet/transactions?cursor=
// ==========================================
export async function getTransactions(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    const cursor = cursorRaw && idSchema.safeParse(cursorRaw).success ? cursorRaw : null;
    const PAGE = 30;

    const rows = await prisma.transaction.findMany({
      where: {
        userId,
        // Les paiements de commande par Mobile Money n'ont pas touché au portefeuille : on ne les liste pas ici.
        OR: [{ type: { not: 'PAYMENT' } }, { reference: { startsWith: 'WLT-' } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;

    const counterpartyIds = Array.from(new Set(page.map((t) => t.counterpartyId).filter((v): v is string => !!v)));
    const users = counterpartyIds.length
      ? await prisma.user.findMany({ where: { id: { in: counterpartyIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, maskName(u.name)]));

    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: page.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        createdAt: t.createdAt,
        orderId: t.orderId,
        counterpartyName: t.counterpartyId ? names.get(t.counterpartyId) ?? null : null,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  } catch (err) {
    return sendError(res, err, 'getTransactions');
  }
}

// ==========================================
// GET /api/wallet/lookup/:number — identifie le destinataire avant un transfert
// ==========================================
export async function lookupWallet(req: AuthRequest, res: Response) {
  try {
    const number = String(req.params.number ?? '').trim().toUpperCase();
    if (!/^CBF-\d{8}$/.test(number)) throw new HttpError(400, 'Numéro de portefeuille invalide.');

    const wallet = await prisma.wallet.findUnique({ where: { number }, select: { number: true, userId: true, user: { select: { name: true } } } });
    if (!wallet) throw new HttpError(404, 'Aucun portefeuille ne correspond à ce numéro.');
    if (wallet.userId === req.user!.id) throw new HttpError(400, "Vous ne pouvez pas vous envoyer de l'argent à vous-même.");

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: { number: wallet.number, name: maskName(wallet.user.name) } });
  } catch (err) {
    return sendError(res, err, 'lookupWallet');
  }
}

// ==========================================
// POST /api/wallet/deposits — dépôt par Mobile Money
// ==========================================
export async function initiateDeposit(req: AuthRequest, res: Response) {
  try {
    if (!isWonyaPayConfigured()) {
      console.error('[Portefeuille] WonyaPay non configuré.');
      throw new HttpError(503, UNAVAILABLE_MESSAGE);
    }
    const userId = req.user!.id;
    const parsed = depositSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Requête invalide');
    const { currency } = parsed.data;
    const amount = checkAmount(currency, parsed.data.amount);
    const phone = normalizeMobileNumber(parsed.data.phone);
    if (!phone) throw new HttpError(400, 'Numéro Mobile Money invalide (10 chiffres, ex. 0997654321).');

    await ensureWallet(userId);

    // Verrou sur le portefeuille : deux demandes simultanées ne créent pas deux dépôts.
    const prepared = await prisma.$transaction(
      async (tx) => {
        await lockWallet(tx, userId);
        const inProgress = await tx.walletDeposit.findFirst({
          where: { userId, status: 'PENDING', createdAt: { gte: new Date(Date.now() - DEPOSIT_EXPIRY_MS) } },
          orderBy: { createdAt: 'desc' },
        });
        if (inProgress) return { kind: 'in_progress' as const, deposit: inProgress };
        const deposit = await tx.walletDeposit.create({
          data: { userId, refTransa: generateRefTransa(), amount, currency, phoneMasked: maskMobileNumber(phone) },
        });
        return { kind: 'created' as const, deposit };
      },
      { timeout: 10_000 }
    );

    if (prepared.kind === 'in_progress') {
      throw new HttpError(409, 'Un dépôt est déjà en cours.', { code: 'DEPOSIT_IN_PROGRESS', depositId: prepared.deposit.id });
    }

    const deposit = prepared.deposit;
    try {
      const result = await initiateC2B({
        refTransa: deposit.refTransa,
        amount: deposit.amount,
        currency,
        phone,
        motif: 'CBFSOKO - Depot portefeuille',
        callbackUrl: buildCallbackUrl(),
        // Le callback existant lit « paymentId » : on y met l'identifiant du dépôt.
        extra: { paymentId: deposit.id, kind: 'wallet-deposit' },
      });
      const updated = await prisma.walletDeposit.update({
        where: { id: deposit.id },
        data: {
          providerTransactionId: result.providerTransactionId,
          feeAmount: result.feeAmount,
          totalCharged: result.totalCharged,
          network: result.network,
        },
      });
      return res.status(201).json({ success: true, data: depositToPublic(updated) });
    } catch (err) {
      if (!(err instanceof WonyaPayError)) throw err;

      if (!err.definitive) {
        console.warn(`[Portefeuille] Initiation de dépôt incertaine (${err.kind}) pour ${deposit.id} : ${err.message}`);
        return res.status(202).json({ success: true, data: depositToPublic(deposit), notice: 'Vérification de votre dépôt en cours.' });
      }

      await prisma.walletDeposit.updateMany({
        where: { id: deposit.id, status: 'PENDING' },
        data: { status: 'FAILED', failureCode: err.kind === 'invalid' ? 'REFUSED' : 'PROVIDER_ERROR', lastCheckedAt: new Date() },
      });
      if (err.kind === 'auth' || err.kind === 'config') {
        console.error(`[WonyaPay][CRITIQUE] ${err.message} — vérifiez WONYAPAY_TOKEN et WONYAPAY_PARTNER_ID.`);
        throw new HttpError(503, UNAVAILABLE_MESSAGE);
      }
      if (err.kind === 'invalid') {
        throw new HttpError(422, 'Le dépôt a été refusé. Vérifiez votre numéro Mobile Money (réseau pris en charge) puis réessayez.');
      }
      throw new HttpError(502, UNAVAILABLE_MESSAGE);
    }
  } catch (err) {
    return sendError(res, err, 'initiateDeposit');
  }
}

// GET /api/wallet/deposits/:id — sondage de la page
export async function getDeposit(req: AuthRequest, res: Response) {
  try {
    const idParsed = idSchema.safeParse(req.params.id);
    if (!idParsed.success) throw new HttpError(404, 'Dépôt introuvable');
    const deposit = await prisma.walletDeposit.findUnique({ where: { id: idParsed.data } });
    if (!deposit || deposit.userId !== req.user!.id) throw new HttpError(404, 'Dépôt introuvable');

    let current: WalletDeposit = deposit;
    if (deposit.status === 'PENDING') current = (await reconcileDeposit(deposit.id)) ?? deposit;

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: depositToPublic(current) });
  } catch (err) {
    return sendError(res, err, 'getDeposit');
  }
}

// ==========================================
// POST /api/wallet/withdrawals — retrait vers Mobile Money (sans frais)
// ==========================================
export async function createWithdrawal(req: AuthRequest, res: Response) {
  try {
    // Refus AVANT tout débit si le décaissement n'est pas opérationnel.
    if (!isPayoutConfigured()) throw new HttpError(503, 'Les retraits sont momentanément indisponibles. Réessayez plus tard.');

    const userId = req.user!.id;
    const parsed = withdrawSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Requête invalide');
    const { currency } = parsed.data;
    const amount = checkAmount(currency, parsed.data.amount);
    const phone = normalizeMobileNumber(parsed.data.phone);
    if (!phone) throw new HttpError(400, 'Numéro Mobile Money invalide (10 chiffres, ex. 0997654321).');

    await verifyPassword(userId, parsed.data.password);
    await ensureWallet(userId);

    // L'argent est retenu (débité) avant l'envoi, dans la même transaction que la création de la demande.
    const withdrawal = await prisma.$transaction(
      async (tx) => {
        await lockWallet(tx, userId);
        const pending = await tx.walletWithdrawal.count({ where: { userId, status: 'PENDING' } });
        if (pending >= MAX_PENDING_WITHDRAWALS) {
          throw new HttpError(409, 'Vous avez déjà plusieurs retraits en cours. Patientez qu’ils soient traités.');
        }
        if (!(await debitWallet(tx, userId, currency, amount))) throw new HttpError(409, 'Solde insuffisant.');

        const refTransa = generateRefTransa();
        const created = await tx.walletWithdrawal.create({
          data: { userId, refTransa, amount, currency, phoneMasked: maskMobileNumber(phone) },
        });
        await tx.transaction.create({
          data: { userId, type: 'WITHDRAWAL', amount, currency, status: 'PENDING', reference: refTransa },
        });
        return created;
      },
      { timeout: 10_000 }
    );

    try {
      const result = await initiatePayout({
        refTransa: withdrawal.refTransa,
        amount,
        currency,
        phone,
        motif: 'CBFSOKO - Retrait portefeuille',
      });
      const updated = await prisma.walletWithdrawal.update({
        where: { id: withdrawal.id },
        data: { providerTransactionId: result.providerTransactionId, network: result.network },
      });
      return res.status(201).json({ success: true, data: withdrawalToPublic(updated) });
    } catch (err) {
      const definitive = err instanceof PayoutError && err.definitive;
      if (!definitive) {
        // Doute : la demande est peut-être partie. On garde l'argent retenu ; la vérification tranchera.
        console.warn(`[Portefeuille] Envoi de retrait incertain pour ${withdrawal.id} :`, (err as Error)?.message || err);
        return res.status(202).json({ success: true, data: withdrawalToPublic(withdrawal), notice: 'Vérification de votre retrait en cours.' });
      }

      const kind = (err as PayoutError).kind;
      await failWithdrawal(withdrawal, kind === 'invalid' ? 'REFUSED' : 'PROVIDER_ERROR');
      if (kind === 'invalid') {
        throw new HttpError(422, 'Le retrait a été refusé. Vérifiez votre numéro Mobile Money puis réessayez. Votre solde est inchangé.');
      }
      if (kind === 'auth' || kind === 'config') console.error(`[WonyaPay][CRITIQUE] Retrait : ${(err as Error).message}`);
      throw new HttpError(503, `${UNAVAILABLE_MESSAGE} Votre solde est inchangé.`);
    }
  } catch (err) {
    return sendError(res, err, 'createWithdrawal');
  }
}

// GET /api/wallet/withdrawals/:id — sondage de la page
export async function getWithdrawal(req: AuthRequest, res: Response) {
  try {
    const idParsed = idSchema.safeParse(req.params.id);
    if (!idParsed.success) throw new HttpError(404, 'Retrait introuvable');
    const withdrawal = await prisma.walletWithdrawal.findUnique({ where: { id: idParsed.data } });
    if (!withdrawal || withdrawal.userId !== req.user!.id) throw new HttpError(404, 'Retrait introuvable');

    let current: WalletWithdrawal = withdrawal;
    if (withdrawal.status === 'PENDING') current = (await reconcileWithdrawal(withdrawal.id)) ?? withdrawal;

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data: withdrawalToPublic(current) });
  } catch (err) {
    return sendError(res, err, 'getWithdrawal');
  }
}

// ==========================================
// POST /api/wallet/transfers — envoi à un autre portefeuille (par numéro)
// ==========================================
export async function createTransfer(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const parsed = transferSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Requête invalide');
    const { currency, toNumber, idempotencyKey } = parsed.data;
    const amount = checkAmount(currency, parsed.data.amount);

    await verifyPassword(userId, parsed.data.password);
    await ensureWallet(userId);

    const target = await prisma.wallet.findUnique({ where: { number: toNumber }, select: { userId: true } });
    if (!target) throw new HttpError(404, 'Aucun portefeuille ne correspond à ce numéro.');
    if (target.userId === userId) throw new HttpError(400, "Vous ne pouvez pas vous envoyer de l'argent à vous-même.");

    const sender = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const senderRef = `TRF-${idempotencyKey}`;

    try {
      const outcome = await prisma.$transaction(
        async (tx) => {
          // Verrous dans un ordre fixe : deux transferts croisés ne peuvent pas se bloquer mutuellement.
          const [first, second] = [userId, target.userId].sort();
          await lockWallet(tx, first);
          await lockWallet(tx, second);

          // Rejeu de la même demande : on renvoie le résultat déjà enregistré, sans débiter à nouveau.
          const existing = await tx.transaction.findFirst({ where: { userId, reference: senderRef }, select: { id: true } });
          if (existing) return { replayed: true as const, id: existing.id };

          if (!(await debitWallet(tx, userId, currency, amount))) throw new HttpError(409, 'Solde insuffisant.');
          await creditWallet(tx, target.userId, currency, amount);

          const out = await tx.transaction.create({
            data: { userId, type: 'TRANSFER_OUT', amount, currency, status: 'COMPLETED', reference: senderRef, counterpartyId: target.userId },
          });
          await tx.transaction.create({
            data: {
              userId: target.userId,
              type: 'TRANSFER_IN',
              amount,
              currency,
              status: 'COMPLETED',
              reference: `TRF-IN-${crypto.randomUUID()}`,
              counterpartyId: userId,
            },
          });
          await tx.notification.create({
            data: {
              userId: target.userId,
              title: 'Argent reçu',
              message: `${maskName(sender?.name ?? '')} vous a envoyé ${formatAmount(amount, currency)} sur votre portefeuille.`,
            },
          });
          return { replayed: false as const, id: out.id };
        },
        { timeout: 10_000 }
      );

      return res.status(outcome.replayed ? 200 : 201).json({ success: true, data: { id: outcome.id, amount, currency } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'Cette opération a déjà été enregistrée.');
      }
      throw err;
    }
  } catch (err) {
    return sendError(res, err, 'createTransfer');
  }
}

// ==========================================
// POST /api/wallet/pay-order/:orderId — payer une commande avec le solde du portefeuille
// ==========================================
export async function payOrderWithWallet(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const orderIdParsed = idSchema.safeParse(req.params.orderId);
    if (!orderIdParsed.success) throw new HttpError(404, 'Commande introuvable');
    const orderId = orderIdParsed.data;

    const parsed = payOrderSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Requête invalide');
    const { currency, address } = parsed.data;

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
    if (!order) throw new HttpError(404, 'Commande introuvable');
    if (order.buyerId !== userId) throw new HttpError(403, 'Accès refusé');
    if (order.paidAt) throw new HttpError(409, 'Cette commande est déjà payée.');
    if (order.status !== 'COURIER_VERIFIED') throw new HttpError(409, "Cette commande n'est pas encore prête pour le paiement.");
    if (order.items.length === 0 || order.items.some((it) => it.product.isSold)) throw new HttpError(409, "Cet article n'est plus disponible.");

    // Montant recalculé ici, jamais reçu du navigateur.
    const totals = computeGrandTotals(order);
    const amount = currency === 'CDF' ? Math.round(totals.grandTotalCDF) : Math.round(totals.grandTotalUSD * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(409, 'Montant de la commande invalide.');

    await ensureWallet(userId);
    const reference = `WLT-${orderId}`;

    const result = await prisma.$transaction(
      async (tx) => {
        // Même verrou que le paiement Mobile Money : deux paiements simultanés de la même commande sont impossibles.
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        await lockWallet(tx, userId);

        const fresh = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, paidAt: true } });
        if (!fresh || fresh.paidAt || fresh.status !== 'COURIER_VERIFIED') throw new HttpError(409, "Cette commande n'est plus payable.");

        // Un paiement Mobile Money encore en cours ne doit pas être doublé par un paiement portefeuille.
        const mobileInProgress = await tx.payment.findFirst({
          where: { orderId, status: 'PENDING', createdAt: { gte: new Date(Date.now() - DEPOSIT_EXPIRY_MS) } },
          select: { id: true },
        });
        if (mobileInProgress) throw new HttpError(409, 'Un paiement Mobile Money est déjà en cours pour cette commande.');

        if (!(await debitWallet(tx, userId, currency, amount))) {
          throw new HttpError(409, 'Solde insuffisant. Déposez de l’argent dans votre portefeuille puis réessayez.', { code: 'INSUFFICIENT_BALANCE' });
        }

        const now = new Date();
        const updated = await tx.order.updateMany({
          where: { id: orderId, paidAt: null, status: 'COURIER_VERIFIED' },
          data: { paidAt: now, status: 'SHIPPED', deliveryAddress: address },
        });
        if (updated.count === 0) throw new HttpError(409, "Cette commande n'est plus payable.");

        const trx = await tx.transaction.create({
          data: { userId, type: 'PAYMENT', amount, currency, status: 'COMPLETED', reference, orderId },
        });

        const full = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            buyerId: true,
            courierId: true,
            items: { select: { productId: true, product: { select: { title: true, sellerId: true } } } },
          },
        });
        if (full) {
          const title = full.items[0]?.product.title ?? 'votre article';
          await tx.notification.createMany({
            data: [
              {
                userId: full.buyerId,
                title: 'Paiement confirmé',
                message: `Votre paiement pour "${title}" est confirmé. Votre commande est en cours de livraison.`,
              },
              ...Array.from(new Set(full.items.map((it) => it.product.sellerId))).map((sellerId) => ({
                userId: sellerId,
                title: 'Article payé',
                message: `"${title}" a été payé. CBFSOKO organise la livraison.`,
              })),
              ...(full.courierId
                ? [{ userId: full.courierId, title: 'Commande payée', message: `La commande "${title}" est payée : vous pouvez la livrer.` }]
                : []),
            ],
          });
          await tx.product.updateMany({
            where: { id: { in: full.items.map((it) => it.productId) }, quantity: { lte: 1 } },
            data: { isSold: true },
          });
        }
        return trx;
      },
      { timeout: 15_000 }
    );

    return res.status(201).json({
      success: true,
      // Même forme que le paiement Mobile Money : la page de paiement affiche directement « Paiement confirmé ».
      data: {
        id: result.id,
        orderId,
        status: 'SUCCESS',
        amount,
        currency,
        feeAmount: null,
        totalCharged: null,
        network: null,
        phoneMasked: '',
        failureCode: null,
        createdAt: result.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'Cette commande a déjà été payée.' });
    }
    return sendError(res, err, 'payOrderWithWallet');
  }
}