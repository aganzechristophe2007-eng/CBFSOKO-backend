import { Router } from 'express';
import { getMyOrders, getOrderById, createOrder, updateOrderStatus } from '../controllers/orders.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', getMyOrders);
router.get('/:id', getOrderById);
router.post('/', createOrder);
router.put('/:id/status', updateOrderStatus);

export default router;
