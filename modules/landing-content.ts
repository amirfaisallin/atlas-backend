import type { Request, Response } from 'express';
import { getDb } from './db';

const COLLECTION = 'site_content';
const LANDING_ID = 'landing';

/** Public: get landing page content (for main site). Returns stored content or empty object. */
export async function handleGetLandingContent(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({});
      return;
    }
    const doc = await db.collection(COLLECTION).findOne({ id: LANDING_ID });
    const content = (doc && typeof doc.content === 'object') ? doc.content : {};
    res.json(content);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: get landing page content (same as public). */
export async function handleAdminGetLandingContent(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ content: {} });
      return;
    }
    const doc = await db.collection(COLLECTION).findOne({ id: LANDING_ID });
    const content = (doc && typeof doc.content === 'object') ? doc.content : {};
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: update landing page content. Body: { content: object }. */
export async function handleAdminUpdateLandingContent(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const content = req.body && typeof req.body.content === 'object' ? req.body.content : {};
    const updatedAt = new Date().toISOString();
    await db.collection(COLLECTION).updateOne(
      { id: LANDING_ID },
      { $set: { id: LANDING_ID, content, updatedAt } },
      { upsert: true }
    );
    res.json({ ok: true, content, updatedAt });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
