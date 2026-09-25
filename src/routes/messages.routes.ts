import { Router } from 'express';
import { getMessages, getUnreadCount, sendMessage, markMessagesRead } from '../controllers/messages.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', getMessages);
router.get('/unread-count', getUnreadCount);
router.post('/', sendMessage);
router.post('/mark-read', markMessagesRead);

export default router;
