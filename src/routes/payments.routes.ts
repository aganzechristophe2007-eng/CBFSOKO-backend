import { Router, Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import {
  initiatePayment,
  getPayment,
  getLatestPaymentForOrder,
  wonyapayCallback,
} from '../controllers/payments.controller';

const router = Router();

// Limite par utilisateur connecté (et non par IP) pour ne pas pénaliser un réseau partagé.
const byUser = (req: Request) => (req as AuthRequest).user?.id ?? ipKeyGenerator(req.ip ?? '');

const callbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false },
});

const initiateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6, // 6 tentatives de paiement par 10 minutes et par utilisateur
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUser,
  message: { success: false, message: 'Trop de tentatives de paiement. Réessayez dans quelques minutes.' },
});

const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUser,
  message: { success: false, message: 'Trop de requêtes. Patientez un instant.' },
});

// Appelée par WonyaPay : pas de cookie de session. Protégée par l'adresse secrète, et le contenu
// n'est jamais cru (voir payments.controller.ts). Doit rester AVANT requireAuth.
router.post('/callback/wonyapay/:secret', callbackLimiter, wonyapayCallback);

router.use(requireAuth);

router.post('/orders/:orderId/initiate', initiateLimiter, initiatePayment);
router.get('/orders/:orderId/latest', pollLimiter, getLatestPaymentForOrder);
router.get('/:id', pollLimiter, getPayment);

export default router;