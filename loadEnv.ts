/**
 * Try multiple .env locations so hosting panels work even when app directory changes.
 * Must be imported first in server.ts so Cloudinary/MongoDB get correct config.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
];

for (const envPath of candidates) {
  if (!fs.existsSync(envPath)) continue;
  dotenv.config({ path: envPath });
  break;
}
