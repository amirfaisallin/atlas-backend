import type { Request, Response } from 'express';
import { getDb } from './db';

const COLLECTION = 'site_content';
const DOC_ID = 'menu_links';

export interface MenuLinksDoc {
  id: string;
  telegramUrl: string;
  affiliateUrl: string;
  updatedAt?: string;
}

const defaults: MenuLinksDoc = {
  id: DOC_ID,
  telegramUrl: '',
  affiliateUrl: '',
};

/** Public: get menu links for main site (Join Telegram, Affiliate Program). */
export async function handleGet(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ telegramUrl: '', affiliateUrl: '' });
      return;
    }
    const doc = await db.collection<MenuLinksDoc>(COLLECTION).findOne({ id: DOC_ID });
    const telegramUrl = typeof doc?.telegramUrl === 'string' ? doc.telegramUrl : defaults.telegramUrl;
    const affiliateUrl = typeof doc?.affiliateUrl === 'string' ? doc.affiliateUrl : defaults.affiliateUrl;
    res.json({ telegramUrl, affiliateUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: get menu links (same shape). */
export async function handleAdminGet(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ telegramUrl: '', affiliateUrl: '' });
      return;
    }
    const doc = await db.collection<MenuLinksDoc>(COLLECTION).findOne({ id: DOC_ID });
    const telegramUrl = typeof doc?.telegramUrl === 'string' ? doc.telegramUrl : defaults.telegramUrl;
    const affiliateUrl = typeof doc?.affiliateUrl === 'string' ? doc.affiliateUrl : defaults.affiliateUrl;
    res.json({ telegramUrl, affiliateUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: update menu links. Body: { telegramUrl?: string, affiliateUrl?: string }. */
export async function handleAdminPut(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const telegramUrl = typeof req.body?.telegramUrl === 'string' ? req.body.telegramUrl : '';
    const affiliateUrl = typeof req.body?.affiliateUrl === 'string' ? req.body.affiliateUrl : '';
    const updatedAt = new Date().toISOString();
    await db.collection<MenuLinksDoc>(COLLECTION).updateOne(
      { id: DOC_ID },
      { $set: { id: DOC_ID, telegramUrl, affiliateUrl, updatedAt } },
      { upsert: true }
    );
    res.json({ ok: true, telegramUrl, affiliateUrl, updatedAt });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
