import multer from 'multer';
import { Request } from 'express';

// Stockage temporaire en RAM (aucun écriture sur le disque du serveur)
const storage = multer.memoryStorage();

// Filtrage strict pour n'accepter que les images et les vidéos
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Format de fichier non supporté. Seules les images et vidéos sont autorisées.'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // Limite à 50 Mo par fichier (idéal pour les vidéos de présentation)
  },
});

export default upload;