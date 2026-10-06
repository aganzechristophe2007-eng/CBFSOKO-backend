import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { WalletDeposit, WalletWithdrawal } from '@prisma/client';
import prisma from '../lib/prisma';
import { getTransactionStatus, mapProviderStatus } from './Wonyapay.service';
import type { ProviderStatus } from './Wonyapay.service';
import { getPayoutStatus } from './wonyapayPayout.service';

// ==========================================
// REGISTRE DU PORTEFEUILLE — principes de sécurité
//  1. Un solde ne change JAMAIS sur la foi du navigateur ou d'un callback : un dépôt n'est crédité que si
//     WonyaPay confirme son état quand NOUS l'interrogeons (même principe que les paiements de commande).
//  2. Tout mouvement d'argent est une transaction atomique. Un débit est conditionnel (« solde >= montant »),
//     donc un solde ne peut jamais devenir négatif, même avec deux requêtes simultanées.
//  3. Idempotence : la « réclamation » d'un dépôt ou d'un retrait est un UPDATE conditionnel unique.
//  4. Retrait : l'argent est retenu (débité) AVANT l'envoi. Il n'est rendu que si WonyaPay confirme l'échec.
//     Si le résultat est incertain, le retrait reste « en attente » et le rattrapage tranche.
// ==========================================

export type Currency = 'CDF' | 'USD';
export const isCurrency = (v: unknown): v is Currency => v === 'CDF' || v === 'USD';

export const roundMoney = (amount: number, currency: Currency) =>
  currency === 'CDF' ? Math.round(amount) : Math.round(amount * 100) / 100;

export const formatAmount = (amount: number, currency: Currency) =>
  currency === 'CDF'
    ? `${Math.round(amount).toLocaleString('fr-FR')} CDF`
    : `${amount.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

const EXPIRY_MS = 10 * 60 * 1000; // dépôt sans confirmation au bout de 10 min : EXPIRED
const NOT_FOUND_GRACE_MS = 90 * 1000;
const PAYOUT_NOT_FOUND_GRACE_MS = 5 * 60 * 1000;
const PAYOUT_REVIEW_AFTER_MS = 24 * 60 * 60 * 1000; // un retrait bloqué plus de 24 h passe en vérification manuelle
const LATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_RECHECK_MS = 3 * 1000;
const SWEEP_BATCH = 50;

type Tx = Prisma.TransactionClient;

// ------------------------------------------
// Numéro de portefeuille (public, partageable) : CBF-12345678
// ------------------------------------------
const generateWalletNumber = () => `CBF-${crypto.randomInt(10_000_000, 100_000_000)}`;

// Garantit que l'utilisateur a un portefeuille ET un numéro (les anciens comptes n'en ont pas encore).
export async function ensureWallet(userId: string) {
  let wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (wallet?.number) return wallet;

  for (let i = 0; i < 6; i++) {
    try {
      if (!wallet) {
        wallet = await prisma.wallet.create({ data: { userId, number: generateWalletNumber() } });
      } else {
        await prisma.wallet.updateMany({ where: { userId, number: null }, data: { number: generateWalletNumber() } });
        wallet = await prisma.wallet.findUnique({ where: { userId } });
      }
      if (wallet?.number) return wallet;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (wallet?.number) return wallet;
    }
  }
  throw new Error('Impossible de générer un numéro de portefeuille.');
}

// ------------------------------------------
// Opérations de solde (à appeler DANS une transaction)
// ------------------------------------------
export async function lockWallet(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
}

export async function creditWallet(tx: Tx, userId: string, currency: Currency, amount: number) {
  if (currency === 'CDF') {
    await tx.wallet.upsert({
      where: { userId },
      create: { userId, balanceCDF: amount },
      update: { balanceCDF: { increment: amount } },
    });
  } else {
    await tx.wallet.upsert({
      where: { userId },
      create: { userId, balanceUSD: amount },
      update: { balanceUSD: { increment: amount } },
    });
  }
}

// Retourne false si le solde est insuffisant (rien n'est modifié dans ce cas).
export async function debitWallet(tx: Tx, userId: string, currency: Currency, amount: number): Promise<boolean> {
  const result =
    currency === 'CDF'
      ? await tx.wallet.updateMany({
          where: { userId, balanceCDF: { gte: amount } },
          data: { balanceCDF: { decrement: amount } },
        })
      : await tx.wallet.updateMany({
          where: { userId, balanceUSD: { gte: amount } },
          data: { balanceUSD: { decrement: amount } },
        });
  return result.count === 1;
}

// ==========================================
// DÉPÔTS (Mobile Money -> portefeuille)
// ==========================================
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.01;

function depositMatches(dep: WalletDeposit, st: ProviderStatus): boolean {
  if (st.refTransa && st.refTransa !== dep.refTransa) return false;
  if (st.devise && st.devise !== dep.currency) return false;
  if (st.amount !== null && !sameAmount(st.amount, dep.amount)) return false;
  if (st.transactionId && dep.providerTransactionId && st.transactionId !== dep.providerTransactionId) return false;
  return true;
}

async function markDepositTerminal(id: string, status: 'FAILED' | 'EXPIRED', failureCode: string) {
  await prisma.walletDeposit.updateMany({
    where: { id, status: { in: status === 'FAILED' ? ['PENDING', 'EXPIRED'] : ['PENDING'] } },
    data: { status, failureCode, lastCheckedAt: new Date() },
  });
}

async function touchDeposit(id: string) {
  await prisma.walletDeposit.updateMany({ where: { id }, data: { lastCheckedAt: new Date() } });
}

// Crédite le portefeuille en une seule transaction atomique. Un seul appel peut « réclamer » le dépôt.
async function confirmDeposit(dep: WalletDeposit) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.walletDeposit.updateMany({
      where: { id: dep.id, status: { in: ['PENDING', 'EXPIRED'] } },
      data: { status: 'SUCCESS', confirmedAt: now, lastCheckedAt: now, failureCode: null },
    });
    if (claimed.count === 0) return;

    await creditWallet(tx, dep.userId, dep.currency as Currency, dep.amount);
    await tx.transaction.create({
      data: {
        userId: dep.userId,
        type: 'DEPOSIT',
        amount: dep.amount,
        currency: dep.currency,
        status: 'COMPLETED',
        reference: dep.refTransa,
      },
    });
    await tx.notification.create({
      data: {
        userId: dep.userId,
        title: 'Dépôt confirmé',
        message: `Votre dépôt de ${formatAmount(dep.amount, dep.currency as Currency)} a été ajouté à votre portefeuille.`,
      },
    });
  });
}

export async function reconcileDeposit(depositId: string, opts: { force?: boolean } = {}): Promise<WalletDeposit | null> {
  const dep = await prisma.walletDeposit.findUnique({ where: { id: depositId } });
  if (!dep) return null;
  if (dep.status === 'SUCCESS' || dep.status === 'FAILED') return dep;
  if (!opts.force && dep.lastCheckedAt && Date.now() - dep.lastCheckedAt.getTime() < MIN_RECHECK_MS) return dep;

  const ageMs = Date.now() - dep.createdAt.getTime();

  let st: ProviderStatus;
  try {
    st = await getTransactionStatus(dep.refTransa);
  } catch (err: any) {
    console.error(`[Portefeuille] Vérification du dépôt ${dep.id} impossible :`, err?.message || err);
    await touchDeposit(dep.id);
    return prisma.walletDeposit.findUnique({ where: { id: dep.id } });
  }

  if (!st.found) {
    if (dep.status === 'PENDING' && ageMs > NOT_FOUND_GRACE_MS) await markDepositTerminal(dep.id, 'FAILED', 'NOT_FOUND');
    else await touchDeposit(dep.id);
    return prisma.walletDeposit.findUnique({ where: { id: dep.id } });
  }

  const mapped = mapProviderStatus(st.rawStatus);
  const consistent = depositMatches(dep, st);

  if (mapped === 'SUCCESS') {
    if (!consistent) {
      // Succès annoncé avec un autre montant, une autre devise ou un autre identifiant : on ne crédite JAMAIS.
      console.error(
        `[SÉCURITÉ][Portefeuille] Succès incohérent pour le dépôt ${dep.id} : attendu ${dep.amount} ${dep.currency} / ${dep.providerTransactionId}, reçu ${st.amount} ${st.devise} / ${st.transactionId}`
      );
      await prisma.walletDeposit.updateMany({
        where: { id: dep.id, status: { in: ['PENDING', 'EXPIRED'] } },
        data: { status: 'FAILED', failureCode: 'AMOUNT_MISMATCH', refundRequired: true, lastCheckedAt: new Date() },
      });
    } else {
      await confirmDeposit(dep);
    }
  } else if (mapped === 'FAILED') {
    if (consistent) await markDepositTerminal(dep.id, 'FAILED', 'DECLINED');
    else await touchDeposit(dep.id);
  } else if (dep.status === 'PENDING' && ageMs > EXPIRY_MS) {
    await markDepositTerminal(dep.id, 'EXPIRED', 'EXPIRED');
  } else {
    await touchDeposit(dep.id);
  }

  return prisma.walletDeposit.findUnique({ where: { id: dep.id } });
}

// ==========================================
// RETRAITS (portefeuille -> Mobile Money)
// ==========================================
async function touchWithdrawal(id: string) {
  await prisma.walletWithdrawal.updateMany({ where: { id }, data: { lastCheckedAt: new Date() } });
}

async function completeWithdrawal(w: WalletWithdrawal) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.walletWithdrawal.updateMany({
      where: { id: w.id, status: 'PENDING' },
      data: { status: 'COMPLETED', completedAt: now, lastCheckedAt: now, failureCode: null },
    });
    if (claimed.count === 0) return;
    await tx.transaction.updateMany({ where: { userId: w.userId, reference: w.refTransa }, data: { status: 'COMPLETED' } });
    await tx.notification.create({
      data: {
        userId: w.userId,
        title: 'Retrait effectué',
        message: `Votre retrait de ${formatAmount(w.amount, w.currency as Currency)} a été envoyé sur ${w.phoneMasked}.`,
      },
    });
  });
}

// Rend l'argent retenu, une seule fois, uniquement si la demande est bien en attente.
export async function failWithdrawal(w: WalletWithdrawal, failureCode: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.walletWithdrawal.updateMany({
      where: { id: w.id, status: 'PENDING' },
      data: { status: 'FAILED', failureCode, lastCheckedAt: now },
    });
    if (claimed.count === 0) return;
    await creditWallet(tx, w.userId, w.currency as Currency, w.amount);
    await tx.transaction.updateMany({ where: { userId: w.userId, reference: w.refTransa }, data: { status: 'FAILED' } });
    await tx.notification.create({
      data: {
        userId: w.userId,
        title: 'Retrait échoué',
        message: `Votre retrait de ${formatAmount(w.amount, w.currency as Currency)} n'a pas abouti. Le montant a été remis dans votre portefeuille.`,
      },
    });
  });
}

export async function reconcileWithdrawal(withdrawalId: string, opts: { force?: boolean } = {}): Promise<WalletWithdrawal | null> {
  const w = await prisma.walletWithdrawal.findUnique({ where: { id: withdrawalId } });
  if (!w) return null;
  if (w.status !== 'PENDING') return w;
  if (!opts.force && w.lastCheckedAt && Date.now() - w.lastCheckedAt.getTime() < MIN_RECHECK_MS) return w;

  const ageMs = Date.now() - w.createdAt.getTime();

  let st;
  try {
    st = await getPayoutStatus(w.refTransa);
  } catch (err: any) {
    console.error(`[Portefeuille] Vérification du retrait ${w.id} impossible :`, err?.message || err);
    await touchWithdrawal(w.id);
    return prisma.walletWithdrawal.findUnique({ where: { id: w.id } });
  }

  if (!st.found) {
    // WonyaPay ne connaît pas cette référence : la demande n'est jamais partie, l'argent est rendu.
    if (ageMs > PAYOUT_NOT_FOUND_GRACE_MS) await failWithdrawal(w, 'NOT_FOUND');
    else await touchWithdrawal(w.id);
  } else if (st.state === 'SUCCESS') {
    const consistent =
      (st.amount === null || sameAmount(st.amount, w.amount)) && (!st.devise || st.devise === w.currency);
    if (consistent) {
      await completeWithdrawal(w);
    } else {
      console.error(`[SÉCURITÉ][Portefeuille] Retrait ${w.id} : montant ou devise incohérents côté WonyaPay.`);
      await prisma.walletWithdrawal.updateMany({ where: { id: w.id, status: 'PENDING' }, data: { needsReview: true, lastCheckedAt: new Date() } });
    }
  } else if (st.state === 'FAILED') {
    await failWithdrawal(w, 'DECLINED');
  } else if (ageMs > PAYOUT_REVIEW_AFTER_MS) {
    // Ni confirmé ni refusé depuis 24 h : ni remboursement automatique (risque de double paiement), ni attente infinie.
    console.error(`[Portefeuille][VÉRIFICATION MANUELLE] Retrait ${w.id} (${w.refTransa}) en attente depuis plus de 24 h.`);
    await prisma.walletWithdrawal.updateMany({ where: { id: w.id, status: 'PENDING' }, data: { needsReview: true, lastCheckedAt: new Date() } });
  } else {
    await touchWithdrawal(w.id);
  }

  return prisma.walletWithdrawal.findUnique({ where: { id: w.id } });
}

// ==========================================
// Rattrapage périodique (appelé depuis server.ts toutes les 30 s)
// ==========================================
export async function sweepWalletOperations() {
  const now = Date.now();

  const deposits = await prisma.walletDeposit.findMany({
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
  for (const { id } of deposits) {
    try {
      await reconcileDeposit(id, { force: true });
    } catch (err) {
      console.error(`Erreur rattrapage dépôt ${id}:`, err);
    }
  }

  const withdrawals = await prisma.walletWithdrawal.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lte: new Date(now - 20_000) },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now - 10_000) } }],
    },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
    select: { id: true },
  });
  for (const { id } of withdrawals) {
    try {
      await reconcileWithdrawal(id, { force: true });
    } catch (err) {
      console.error(`Erreur rattrapage retrait ${id}:`, err);
    }
  }
}