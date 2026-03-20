import type { Request, Response } from 'express';
import { getDb } from './db';

const COLLECTION = 'site_content';
const DOC_ID = 'support_config';

export interface SupportConfigDoc {
  id: string;
  supportEmail: string;
  updatedAt?: string;
}

const defaults: SupportConfigDoc = {
  id: DOC_ID,
  supportEmail: 'support@yourwebsite.com',
};

function normalizeEmail(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s;
}

/** Public: get support email for login banners and other public messages. */
export async function handleGet(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ supportEmail: defaults.supportEmail });
      return;
    }
    const doc = await db.collection<SupportConfigDoc>(COLLECTION).findOne({ id: DOC_ID });
    const supportEmail = normalizeEmail(doc?.supportEmail) || defaults.supportEmail;
    res.json({ supportEmail });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: get support config (same shape). */
export async function handleAdminGet(_req: Request, res: Response): Promise<void> {
  return handleGet(_req, res);
}

/** Admin: update support email. Body: { supportEmail?: string }. */
export async function handleAdminPut(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const supportEmail = normalizeEmail(req.body?.supportEmail) || defaults.supportEmail;
    const updatedAt = new Date().toISOString();
    await db.collection<SupportConfigDoc>(COLLECTION).updateOne(
      { id: DOC_ID },
      { $set: { id: DOC_ID, supportEmail, updatedAt } },
      { upsert: true }
    );
    res.json({ ok: true, supportEmail, updatedAt });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

