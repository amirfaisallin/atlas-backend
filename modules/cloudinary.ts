import { v2 as cloudinary } from 'cloudinary';

// Support both separate env vars and single CLOUDINARY_URL (cloudinary://api_key:api_secret@cloud_name)
function getConfig() {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  let apiKey = process.env.CLOUDINARY_API_KEY;
  let apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (cloudName && apiKey && apiSecret) {
    return { cloudName, apiKey, apiSecret };
  }

  const url = process.env.CLOUDINARY_URL;
  if (url && url.startsWith('cloudinary://')) {
    try {
      const parsed = new URL(url);
      // Format: cloudinary://api_key:api_secret@cloud_name
      const name = parsed.hostname || parsed.host || '';
      if (parsed.username && parsed.password && name) {
        cloudName = name;
        apiKey = decoded(parsed.username);
        apiSecret = decoded(parsed.password);
        return { cloudName, apiKey, apiSecret };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const config = getConfig();

if (config) {
  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
  });
  console.log('[Cloudinary] Configured. Screenshots and user images will be stored on Cloudinary.');
} else {
  console.warn('[Cloudinary] Not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (or CLOUDINARY_URL) in .env');
}

export function isCloudinaryConfigured(): boolean {
  return config !== null;
}

/**
 * Upload base64 image (data URI or raw base64) to Cloudinary.
 * Returns secure_url or null if upload fails or Cloudinary is not configured.
 */
export async function uploadBase64ToCloudinary(
  base64Data: string,
  folder = 'altrix-deposits'
): Promise<string | null> {
  if (!config) {
    return null;
  }
  try {
    const result = await cloudinary.uploader.upload(base64Data, {
      folder,
      resource_type: 'image',
    });
    return result.secure_url ?? null;
  } catch (e) {
    console.error('Cloudinary upload error:', e);
    return null;
  }
}
