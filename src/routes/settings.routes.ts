import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, AuthRequest } from '../middleware/auth.middleware';
import * as settingsController from '../controllers/settings.controller';

const router = Router();

// ---------- Upload de la photo de profil ----------
const AVATAR_DIR = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const userId = (req as AuthRequest).user?.id || 'anonyme';
    cb(null, `${userId}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error("Format d'image non supporté (JPEG, PNG ou WEBP uniquement)."));
    }
    cb(null, true);
  },
});

// Multer signale ses erreurs (taille, format) via un callback plutôt que de lever
// une exception classique : on les intercepte ici pour renvoyer une réponse propre.
function handleAvatarUpload(req: AuthRequest, res: Response, next: NextFunction) {
  upload.single('avatar')(req, res, (err: any) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? "L'image ne doit pas dépasser 5 Mo." : err.message;
      return res.status(400).json({ success: false, error: msg, message: msg });
    }
    next();
  });
}

// Toutes les routes de ce fichier exigent d'être connecté.
router.use(requireAuth);

router.patch('/avatar', handleAvatarUpload, settingsController.updateAvatar);
router.get('/products', settingsController.getMyProducts);
router.patch('/products/:id/sold', settingsController.markProductSold);
router.delete('/products/:id', settingsController.deleteProduct);
router.get('/stats', settingsController.getStats);

export default router;