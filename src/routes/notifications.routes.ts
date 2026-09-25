import { Router } from 'express';
import { getNotifications, getUnreadNotifCount, markNotificationsRead } from '../controllers/notifications.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', getNotifications);
router.get('/unread-count', getUnreadNotifCount);
router.post('/mark-read', markNotificationsRead);

export default router;
