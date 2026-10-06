import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { probeAuthVariants, isWonyaPayConfigured } from '../services/Wonyapay.service';

// GET /api/payments/diagnostic — réservé aux ADMIN / SUPER_ADMIN.
// À ouvrir dans le navigateur, connecté, pour voir comment WonyaPay répond à votre token.
const router = Router();

router.get('/', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), async (_req: AuthRequest, res: Response) => {
  try {
    const results = await probeAuthVariants();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      configured: isWonyaPayConfigured(),
      explication:
        "401 = token refusé par WonyaPay. 400 ou 422 = token accepté (la requête vide est refusée pour une autre raison, c'est normal).",
      results,
    });
  } catch (err: unknown) {
    console.error('Erreur diagnostic WonyaPay :', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
});

export default router;