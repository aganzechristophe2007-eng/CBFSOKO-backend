import { Router } from 'express';
import { logCall, getCallHistory } from '../controllers/calls.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', getCallHistory);
router.post('/', logCall);

export default router;