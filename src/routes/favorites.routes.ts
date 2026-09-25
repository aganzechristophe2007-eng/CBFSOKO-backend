import { Router } from 'express';
import { getMyFavorites } from '../controllers/favorites.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/me', requireAuth, getMyFavorites);

export default router;
