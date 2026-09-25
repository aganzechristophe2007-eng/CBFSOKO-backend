import { Router } from 'express';
import { sendFeedback } from '../controllers/feedback.controller';
import { optionalAuth } from '../middleware/auth.middleware';

const router = Router();

router.post('/', optionalAuth, sendFeedback);

export default router;
