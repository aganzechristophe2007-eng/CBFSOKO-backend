import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error(
    'Variables Cloudinary manquantes (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET). Ajoute-les dans ton .env.'
  );
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});

type CloudinaryResourceType = 'image' | 'video';

interface UploadOptions {
  resource_type: CloudinaryResourceType;
  folder: string;
}

export const uploadBufferToCloudinary = (buffer: Buffer, options: UploadOptions): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: options.resource_type, folder: options.folder },
      (error, result) => {
        if (error || !result) return reject(error || new Error('Échec upload Cloudinary'));
        resolve(result);
      }
    );
    Readable.from(buffer).pipe(uploadStream);
  });
};

export default cloudinary;