import { Router, Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import {
  getWallet,
  getTransactions,
  lookupWallet,
  initiateDeposit,
  getDeposit,
  createWithdrawal,
  getWithdrawal,
  createTransfer,
  payOrderWithWallet,
} from '../controllers/wallet.controller';

const router = Router();

// Limite par utilisateur connecté (et non par IP) pour ne pas pénaliser un réseau partagé.
const byUser = (req: Request) => (req as AuthRequest).user?.id ?? ipKeyGenerator(req.ip ?? '');

const make = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: byUser,
    message: { success: false, message },
  });

const readLimiter = make(60 * 1000, 60, 'Trop de requêtes. Patientez un instant.');
// Recherche de destinataire : limitée plus strictement pour empêcher de parcourir les numéros.
const lookupLimiter = make(60 * 1000, 15, 'Trop de recherches. Patientez un instant.');
const depositLimiter = make(10 * 60 * 1000, 6, 'Trop de tentatives de dépôt. Réessayez dans quelques minutes.');
// Retrait et transfert demandent le mot de passe : la limite freine aussi les essais répétés.
const sensitiveLimiter = make(10 * 60 * 1000, 8, 'Trop de tentatives. Réessayez dans quelques minutes.');
const payLimiter = make(10 * 60 * 1000, 10, 'Trop de tentatives de paiement. Réessayez dans quelques minutes.');

router.use(requireAuth);

router.get('/', readLimiter, getWallet);
router.get('/transactions', readLimiter, getTransactions);
router.get('/lookup/:number', lookupLimiter, lookupWallet);

router.post('/deposits', depositLimiter, initiateDeposit);
router.get('/deposits/:id', readLimiter, getDeposit);

router.post('/withdrawals', sensitiveLimiter, createWithdrawal);
router.get('/withdrawals/:id', readLimiter, getWithdrawal);

router.post('/transfers', sensitiveLimiter, createTransfer);

router.post('/pay-order/:orderId', payLimiter, payOrderWithWallet);

export default router;