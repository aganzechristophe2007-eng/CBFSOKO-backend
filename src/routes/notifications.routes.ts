import { Router } from 'express';
import {
  getConversations,
  getConversationMessages,
  getUnreadCount,
  sendMessage,
  sendMediaMessage,
  markConversationRead,
  mediaUpload,
} from '../controllers/messages.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/conversations', getConversations);
router.get('/unread-count', getUnreadCount);
router.get('/:contactId', getConversationMessages);
router.post('/', sendMessage);
router.post('/media', mediaUpload.single('file'), sendMediaMessage);
router.post('/:contactId/read', markConversationRead);

export default router;