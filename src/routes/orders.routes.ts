import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware';
import {
  createDeliveryRequest,
  getMyOrders,
  confirmOrder,
  denyOrder,
  verifyOrderByCourier,
  getOrderPaymentSummary,
} from '../controllers/orders.controller';

const router = Router();

router.use(requireAuth);

// Empêche un acheteur de spammer des demandes de livraison (5 par heure, tous produits confondus).
const deliveryRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de demandes de livraison. Réessayez plus tard.' },
});

router.get('/mine', getMyOrders);
router.post('/delivery-request', deliveryRequestLimiter, createDeliveryRequest);
router.patch('/:id/confirm', confirmOrder);
router.patch('/:id/deny', denyOrder);
// Réservé côté controller aux rôles COURIER/ADMIN (revérifié en base à chaque appel) ;
// requireAuth suffit ici, l'autorisation fine se fait dans verifyOrderByCourier.
router.patch('/:id/verify', verifyOrderByCourier);
router.get('/:id/payment-summary', getOrderPaymentSummary);

export default router;