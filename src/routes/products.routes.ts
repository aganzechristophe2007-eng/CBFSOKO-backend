import { Router } from 'express';
import upload from '../middleware/upload';
import { createProduct, analyzeProductImages, getProductById, createSellerReview } from '../controllers/products.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Fiche produit publique (aucune donnée sensible du vendeur n'est renvoyée)
router.get('/:id', getProductById);

// Noter le vendeur : réservé aux acheteurs, vérifié côté serveur (commande livrée)
router.post('/:id/reviews', requireAuth, createSellerReview);

// Route POST sécurisée pour la publication d'un article avec ses fichiers
router.post(
  '/',
  requireAuth, // Vérifie le cookie HttpOnly et peuple req.user avant l'upload
  upload.fields([
    { name: 'images', maxCount: 7 },
    { name: 'video', maxCount: 1 },
  ]),
  createProduct
);

// Assistant IA (Gemini) : analyse jusqu'à 3 photos et renvoie une suggestion de fiche produit.
// Réservé aux utilisateurs connectés (la clé Gemini reste uniquement côté serveur).
router.post(
  '/analyze',
  requireAuth,
  upload.fields([{ name: 'images', maxCount: 3 }]),
  analyzeProductImages
);

export default router;