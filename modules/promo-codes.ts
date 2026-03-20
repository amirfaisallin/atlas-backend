import type { Request, Response } from 'express';
import { getDb } from './db';

const COLLECTION = 'promo_codes';
const CONFIG_COLLECTION = 'site_content';
const CONFIG_DOC_ID = 'promo_display';
const DEFAULT_BONUS_BANNER_TEXT = 'Apply a promo code at deposit to get up to {max}% bonus.';

export interface PromoCodeDoc {
  _id?: unknown;
  id: string;
  code: string;
  codeNormalized: string;
  bonusPercent: number;
  isActive: boolean;
  createdAt: string;
}

function normalizeCode(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

async function getBonusBannerText(db: ReturnType<typeof getDb>): Promise<string> {
  if (!db) return DEFAULT_BONUS_BANNER_TEXT;
  const doc = await db.collection(CONFIG_COLLECTION).findOne({ id: CONFIG_DOC_ID });
  const text = doc?.bonusBannerText;
  return typeof text === 'string' && text.trim() ? text.trim() : DEFAULT_BONUS_BANNER_TEXT;
}

/** Public: list active promo codes for deposit (code + bonus %) and bonus banner text. */
export async function handleGet(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ promoCodes: [], bonusBannerText: DEFAULT_BONUS_BANNER_TEXT });
      return;
    }
    const coll = db.collection<PromoCodeDoc>(COLLECTION);
    const list = await coll.find({ isActive: true }).sort({ createdAt: -1 }).toArray();
    const bonusBannerText = await getBonusBannerText(db);
    res.json({
      promoCodes: list.map((d) => ({
        code: d.code,
        bonusPercent: d.bonusPercent,
        codeNormalized: d.codeNormalized || normalizeCode(d.code),
      })),
      bonusBannerText,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: list all promo codes and bonus banner text. */
export async function handleAdminList(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ promoCodes: [], bonusBannerText: DEFAULT_BONUS_BANNER_TEXT });
      return;
    }
    const coll = db.collection<PromoCodeDoc>(COLLECTION);
    const list = await coll.find({}).sort({ createdAt: -1 }).toArray();
    const bonusBannerText = await getBonusBannerText(db);
    res.json({ promoCodes: list, bonusBannerText });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: save bonus banner text (shown on deposit modal). Use {max} for max bonus %. */
export async function handleAdminPutConfig(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const bonusBannerText = typeof req.body?.bonusBannerText === 'string' ? req.body.bonusBannerText.trim() : '';
    await db.collection(CONFIG_COLLECTION).updateOne(
      { id: CONFIG_DOC_ID },
      { $set: { id: CONFIG_DOC_ID, bonusBannerText: bonusBannerText || DEFAULT_BONUS_BANNER_TEXT, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
    res.json({ ok: true, bonusBannerText: bonusBannerText || DEFAULT_BONUS_BANNER_TEXT });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: create promo code. */
export async function handleAdminCreate(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const rawCode = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const bonusPercent = typeof req.body?.bonusPercent === 'number'
      ? Math.max(1, Math.min(100, Math.round(req.body.bonusPercent)))
      : typeof req.body?.bonusPercent === 'string'
        ? Math.max(1, Math.min(100, Math.round(parseFloat(req.body.bonusPercent) || 0)))
        : 0;
    if (!rawCode) {
      res.status(400).json({ error: 'Code is required' });
      return;
    }
    const code = normalizeCode(rawCode);
    if (code.length < 2) {
      res.status(400).json({ error: 'Code must be at least 2 characters' });
      return;
    }
    const coll = db.collection<PromoCodeDoc>(COLLECTION);
    const existing = await coll.findOne({ codeNormalized: code });
    if (existing) {
      res.status(400).json({ error: 'This promo code already exists' });
      return;
    }
    const id = `pc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const doc: PromoCodeDoc = {
      id,
      code: rawCode,
      codeNormalized: code,
      bonusPercent,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    await coll.insertOne(doc);
    res.status(201).json({ id: doc.id, code: doc.code, bonusPercent: doc.bonusPercent, isActive: doc.isActive, createdAt: doc.createdAt });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: update promo code. */
export async function handleAdminUpdate(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ error: 'Id required' });
      return;
    }
    const bonusPercent = req.body?.bonusPercent !== undefined
      ? Math.max(1, Math.min(100, Math.round(Number(req.body.bonusPercent) || 0)))
      : undefined;
    const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined;
    const coll = db.collection<PromoCodeDoc>(COLLECTION);
    const update: Record<string, unknown> = {};
    if (bonusPercent !== undefined) update.bonusPercent = bonusPercent;
    if (isActive !== undefined) update.isActive = isActive;
    if (Object.keys(update).length === 0) {
      const doc = await coll.findOne({ id });
      if (!doc) {
        res.status(404).json({ error: 'Promo code not found' });
        return;
      }
      res.json(doc);
      return;
    }
    const result = await coll.findOneAndUpdate(
      { id },
      { $set: update },
      { returnDocument: 'after' }
    );
    if (!result) {
      res.status(404).json({ error: 'Promo code not found' });
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: delete promo code. */
export async function handleAdminDelete(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ error: 'Id required' });
      return;
    }
    const coll = db.collection<PromoCodeDoc>(COLLECTION);
    const result = await coll.deleteOne({ id });
    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Promo code not found' });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
