import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware';
import {
  createDeliveryRequest,
  getMyOrders,
  confirmOrder,
  denyOrder,
  verifyOrderByCourier,
  assignCourier,
  listAvailableCouriers,
  listPendingAssignment,
  getCourierOrders,
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

// Espace livreur — l'autorisation fine (rôle COURIER, commande bien assignée à CE livreur)
// est revérifiée en base dans chaque contrôleur, jamais fait confiance au JWT seul.
router.get('/courier/mine', getCourierOrders);

// Espace admin — dispatch manuel des commandes confirmées vers un livreur.
router.get('/admin/couriers', listAvailableCouriers);
router.get('/admin/pending-assignment', listPendingAssignment);

router.patch('/:id/confirm', confirmOrder);
router.patch('/:id/deny', denyOrder);
router.patch('/:id/assign-courier', assignCourier);
router.patch('/:id/verify', verifyOrderByCourier);
router.get('/:id/payment-summary', getOrderPaymentSummary);

export default router;