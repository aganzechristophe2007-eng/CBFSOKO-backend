import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const QR_DIR = path.join(process.cwd(), 'uploads', 'qrcodes');

if (!fs.existsSync(QR_DIR)) {
  fs.mkdirSync(QR_DIR, { recursive: true });
}

/**
 * Génère un QR code PNG pour un produit et le sauvegarde sur disque.
 * Le QR code encode l'URL publique de la fiche produit
 * (ex: https://cbfsoko.com/products/<id>), afin qu'un scan
 * redirige directement vers l'annonce.
 *
 * @param productId  identifiant du produit (déjà créé en base)
 * @returns le chemin relatif à stocker dans Product.qrCodeUrl
 *          (ex: "uploads/qrcodes/<productId>.png")
 */
export async function generateProductQrCode(productId: string): Promise<string> {
  const frontendUrl = process.env.FRONTEND_URL || 'https://cbfsoko.com';
  const productUrl = `${frontendUrl}/products/${productId}`;

  const fileName = `${productId}.png`;
  const filePath = path.join(QR_DIR, fileName);

  await QRCode.toFile(filePath, productUrl, {
    type: 'png',
    width: 512,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });

  return `uploads/qrcodes/${fileName}`;
}

/**
 * Supprime le QR code d'un produit (utilisé quand un produit est supprimé).
 */
export function deleteProductQrCode(qrCodeUrl?: string | null) {
  if (!qrCodeUrl) return;
  const absolutePath = path.join(process.cwd(), qrCodeUrl.replace(/^uploads\//, 'uploads/'));
  fs.unlink(absolutePath, () => {
    // silencieux : le fichier peut déjà ne plus exister
  });
}
