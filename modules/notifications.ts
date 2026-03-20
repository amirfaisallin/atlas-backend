import type { Request, Response } from 'express';
import { getDb } from './db';
import { ObjectId } from 'mongodb';

const COLLECTION = 'notifications';

export type NotificationType = 'warning' | 'website_update' | 'promo_code';

export interface NotificationDoc {
  _id?: ObjectId;
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  /** When type is promo_code, shown highlighted and copyable on main site */
  promoCode?: string;
  createdAt: string;
  order: number;
}

const DEFAULT_NOTIFICATIONS: Omit<NotificationDoc, '_id'>[] = [
  { id: 'default-warning', type: 'warning', title: 'Important Notice', message: 'Please ensure your account is secured with a strong password and 2FA. Avoid sharing credentials.', createdAt: new Date().toISOString(), order: 0 },
  { id: 'default-website', type: 'website_update', title: 'Website Update', message: 'We have updated our platform with faster execution and new features. Thank you for trading with us.', createdAt: new Date().toISOString(), order: 1 },
  { id: 'default-promo', type: 'promo_code', title: 'Welcome Bonus', message: 'Use promo code WELCOME20 at deposit to claim your welcome bonus. Terms apply.', promoCode: 'WELCOME20', createdAt: new Date().toISOString(), order: 2 },
];

function toPublicItem(doc: NotificationDoc): { id: string; type: NotificationType; title: string; message: string; timeLabel: string; promoCode?: string } {
  const d = doc.createdAt ? new Date(doc.createdAt) : new Date();
  const timeLabel = d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).replace(',', ',');
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    timeLabel,
    ...(doc.promoCode ? { promoCode: doc.promoCode } : {}),
  };
}

/** Public: list notifications for main site (no auth). */
export async function handleGet(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ notifications: [] });
      return;
    }
    const coll = db.collection<NotificationDoc>(COLLECTION);
    const list = await coll.find({}).sort({ order: 1, createdAt: -1 }).toArray();
    if (list.length === 0) {
      await coll.insertMany(DEFAULT_NOTIFICATIONS.map((d) => ({ ...d })));
      const after = await coll.find({}).sort({ order: 1, createdAt: -1 }).toArray();
      res.json({ notifications: after.map(toPublicItem) });
      return;
    }
    res.json({ notifications: list.map(toPublicItem) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: list all notifications. */
export async function handleAdminList(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({ notifications: [] });
      return;
    }
    const coll = db.collection<NotificationDoc>(COLLECTION);
    let list = await coll.find({}).sort({ order: 1, createdAt: -1 }).toArray();
    if (list.length === 0) {
      await coll.insertMany(DEFAULT_NOTIFICATIONS.map((d) => ({ ...d })));
      list = await coll.find({}).sort({ order: 1, createdAt: -1 }).toArray();
    }
    res.json({ notifications: list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: create notification. */
export async function handleAdminCreate(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const type = (req.body?.type as NotificationType) || 'website_update';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const promoCode = type === 'promo_code' && typeof req.body?.promoCode === 'string' ? req.body.promoCode.trim() || undefined : undefined;
    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    const validTypes: NotificationType[] = ['warning', 'website_update', 'promo_code'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: 'Invalid type. Use warning, website_update, or promo_code' });
      return;
    }
    const coll = db.collection<NotificationDoc>(COLLECTION);
    const count = await coll.countDocuments();
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const doc: NotificationDoc = {
      id,
      type,
      title,
      message,
      ...(promoCode ? { promoCode } : {}),
      createdAt: new Date().toISOString(),
      order: count,
    };
    await coll.insertOne(doc);
    res.status(201).json(doc);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: update notification. */
export async function handleAdminUpdate(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ error: 'Notification id required' });
      return;
    }
    const type = req.body?.type as NotificationType | undefined;
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : undefined;
    const promoCode = req.body?.promoCode !== undefined
      ? (typeof req.body.promoCode === 'string' ? req.body.promoCode.trim() || null : null)
      : undefined;
    const validTypes: NotificationType[] = ['warning', 'website_update', 'promo_code'];
    if (type != null && !validTypes.includes(type)) {
      res.status(400).json({ error: 'Invalid type' });
      return;
    }
    const coll = db.collection<NotificationDoc>(COLLECTION);
    const update: Partial<NotificationDoc> = {};
    if (type != null) update.type = type;
    if (title != null) update.title = title;
    if (message != null) update.message = message;
    if (promoCode !== undefined) update.promoCode = promoCode || undefined;
    if (Object.keys(update).length === 0) {
      const doc = await coll.findOne({ id });
      if (!doc) {
        res.status(404).json({ error: 'Notification not found' });
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
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: delete notification. */
export async function handleAdminDelete(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const id = req.params?.id;
    if (!id) {
      res.status(400).json({ error: 'Notification id required' });
      return;
    }
    const coll = db.collection<NotificationDoc>(COLLECTION);
    const result = await coll.deleteOne({ id });
    if (result.deletedCount === 0) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
