import { Router } from 'express';
import { getCategories, createCategory } from '../controllers/categories.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/', getCategories);
router.post('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), createCategory);

export default router;
