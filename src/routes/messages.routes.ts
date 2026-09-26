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

// Toute la messagerie exige d'être connecté : personne ne doit pouvoir lire
// ou envoyer des messages sans un cookie de session valide.
router.use(requireAuth);

// ⚠️ Les routes fixes ('/conversations', '/unread-count', '/media') doivent être
// déclarées AVANT la route dynamique '/:contactId', sinon Express les confondrait
// avec un contactId littéral "conversations", "unread-count" ou "media".
router.get('/conversations', getConversations);
router.get('/unread-count', getUnreadCount);

// mediaUpload vérifie déjà le type MIME et limite la taille (25 Mo) avant que
// le contrôleur ne traite le fichier — donc rien de non filtré n'atteint Cloudinary.
router.post('/media', mediaUpload.single('file'), sendMediaMessage);

router.post('/', sendMessage);

router.get('/:contactId', getConversationMessages);
router.post('/:contactId/read', markConversationRead);

export default router;