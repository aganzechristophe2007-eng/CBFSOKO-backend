import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'products');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  },
});

const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO = ['video/mp4', 'video/webm', 'video/quicktime'];

function fileFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if ([...ALLOWED_IMAGE, ...ALLOWED_VIDEO].includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Format de fichier non supporté'));
  }
}

// jusqu'à 6 images ("images") + 1 vidéo max 30s ("video")
export const uploadProductFiles = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 Mo / fichier
}).fields([
  { name: 'images', maxCount: 6 },
  { name: 'video', maxCount: 1 },
]);
