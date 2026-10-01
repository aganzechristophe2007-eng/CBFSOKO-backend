import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { getDashboard } from '../controllers/admin-seller.controller';

const router = Router();

// Le rôle est lu en base par requireAuth (jamais fourni par le frontend).
router.get('/dashboard', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), getDashboard);

export default router;
