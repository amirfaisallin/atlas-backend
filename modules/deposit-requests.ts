import type { Request, Response } from 'express';
import { depositRequestsCollection, transactionsCollection } from './db';
import { getUserById, setUserRealBalance } from './admin-users';
import { uploadBase64ToCloudinary, isCloudinaryConfigured } from './cloudinary';
import { generateDepositTransactionId } from './transaction-id';
import { emitAdminNotification } from './admin-socket';

export interface DepositRequestPayload {
  accountId: string;
  amount: number;
  paymentMethod: string;
  transactionId: string;
  screenshotBase64?: string;
  screenshotName?: string;
}

/** User submits deposit request from main site (after entering tx id + screenshot) */
export async function handleCreateDepositRequest(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, amount, paymentMethod, transactionId, screenshotBase64, screenshotName } = req.body as DepositRequestPayload;
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 10 || numAmount > 10000) {
      res.status(400).json({ error: 'Amount must be between 10 and 10000' });
      return;
    }
    if (!paymentMethod || typeof paymentMethod !== 'string' || !transactionId || typeof transactionId !== 'string') {
      res.status(400).json({ error: 'paymentMethod and transactionId are required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const id = `DR-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const userTransactionId = await generateDepositTransactionId();
    const now = new Date().toISOString();
    let screenshotUrl: string | undefined;
    if (typeof screenshotBase64 === 'string' && screenshotBase64.length > 0) {
      if (!isCloudinaryConfigured()) {
        res.status(503).json({ error: 'Image upload is not configured. Please try again later.' });
        return;
      }
      const cloudinaryUrl = await uploadBase64ToCloudinary(screenshotBase64);
      if (!cloudinaryUrl) {
        res.status(503).json({ error: 'Screenshot upload failed. Please try again.' });
        return;
      }
      screenshotUrl = cloudinaryUrl;
    }
    const doc = {
      id,
      userTransactionId,
      accountId,
      amount: numAmount,
      paymentMethod: paymentMethod.trim(),
      transactionId: transactionId.trim(),
      screenshot: screenshotUrl,
      screenshotName: typeof screenshotName === 'string' ? screenshotName : undefined,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    };
    await depositRequestsCollection().insertOne(doc as import('./db').DepositRequestDoc & { _id?: unknown });
    const txDoc = {
      id,
      userTransactionId,
      accountId,
      type: 'deposit' as const,
      referenceId: id,
      amount: numAmount,
      paymentMethod: paymentMethod.trim(),
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    };
    await transactionsCollection().insertOne(txDoc as import('./db').TransactionDoc & { _id?: unknown });
    emitAdminNotification({
      type: 'deposit_request',
      id,
      accountId,
      amount: numAmount,
      paymentMethod: paymentMethod.trim(),
      userName: user.name,
      userEmail: user.email,
    });
    res.status(201).json({ id, userTransactionId, message: 'Deposit request submitted' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** User: get my deposit requests (by accountId) – for transaction history with status Pending/Successful/Failed */
export async function handleMyDepositRequests(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const cursor = depositRequestsCollection()
      .find({ accountId }, { projection: { screenshot: 0 } })
      .sort({ createdAt: -1 });
    const docs = await cursor.toArray();
    res.json({ requests: docs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: list deposit requests (newest first). Excludes admin-hidden so user site is unaffected. */
export async function handleListDepositRequests(_req: Request, res: Response): Promise<void> {
  try {
    const cursor = depositRequestsCollection()
      .find({ adminHidden: { $ne: true } })
      .sort({ createdAt: -1 });
    const docs = await cursor.toArray();
    res.json({ requests: docs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: get one deposit request (includes screenshot for viewing) */
export async function handleGetDepositRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const doc = await depositRequestsCollection().findOne({ id });
    if (!doc) {
      res.status(404).json({ error: 'Deposit request not found' });
      return;
    }
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: update amount (pen icon edit) – only for pending */
export async function handleUpdateDepositAmount(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { amount } = req.body as { amount?: number };
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 10 || numAmount > 10000) {
      res.status(400).json({ error: 'Amount must be between 10 and 10000' });
      return;
    }
    const doc = await depositRequestsCollection().findOne({ id });
    if (!doc) {
      res.status(404).json({ error: 'Deposit request not found' });
      return;
    }
    if (doc.status !== 'pending') {
      res.status(400).json({ error: 'Can only edit amount for pending requests' });
      return;
    }
    const now = new Date().toISOString();
    await depositRequestsCollection().updateOne(
      { id },
      { $set: { amount: numAmount, updatedAt: now } }
    );
    await transactionsCollection().updateOne(
      { id },
      { $set: { amount: numAmount, updatedAt: now } }
    );
    res.json({ ...doc, amount: numAmount, updatedAt: now });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: accept – add amount to user real balance and mark accepted */
export async function handleAcceptDepositRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const doc = await depositRequestsCollection().findOne({ id });
    if (!doc) {
      res.status(404).json({ error: 'Deposit request not found' });
      return;
    }
    if (doc.status !== 'pending') {
      res.status(400).json({ error: 'Request already processed' });
      return;
    }
    const user = await getUserById(doc.accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const currentBalance = typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
    const newBalance = currentBalance + doc.amount;
    await setUserRealBalance(doc.accountId, newBalance);
    const now = new Date().toISOString();
    await depositRequestsCollection().updateOne(
      { id },
      { $set: { status: 'accepted', updatedAt: now, reviewedAt: now } }
    );
    await transactionsCollection().updateOne(
      { id },
      { $set: { status: 'successful', updatedAt: now } }
    );
    const updated = await depositRequestsCollection().findOne({ id });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: reject */
export async function handleRejectDepositRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const doc = await depositRequestsCollection().findOne({ id });
    if (!doc) {
      res.status(404).json({ error: 'Deposit request not found' });
      return;
    }
    if (doc.status !== 'pending') {
      res.status(400).json({ error: 'Request already processed' });
      return;
    }
    const now = new Date().toISOString();
    await depositRequestsCollection().updateOne(
      { id },
      { $set: { status: 'rejected', updatedAt: now, reviewedAt: now } }
    );
    await transactionsCollection().updateOne(
      { id },
      { $set: { status: 'failed', updatedAt: now } }
    );
    const updated = await depositRequestsCollection().findOne({ id });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: hide one deposit request from admin list only; user site transaction history unchanged */
export async function handleDeleteDepositRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const doc = await depositRequestsCollection().findOne({ id });
    if (!doc) {
      res.status(404).json({ error: 'Deposit request not found' });
      return;
    }
    await depositRequestsCollection().updateOne({ id }, { $set: { adminHidden: true } });
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: hide all deposit requests from admin list only; user site unchanged */
export async function handleDeleteAllDepositRequests(_req: Request, res: Response): Promise<void> {
  try {
    const result = await depositRequestsCollection().updateMany(
      { adminHidden: { $ne: true } },
      { $set: { adminHidden: true } }
    );
    res.json({ deleted: true, count: result.modifiedCount });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: hide all rejected deposit requests from admin list in one click; user site unchanged */
export async function handleHideRejectedDepositRequests(_req: Request, res: Response): Promise<void> {
  try {
    const result = await depositRequestsCollection().updateMany(
      { status: 'rejected', adminHidden: { $ne: true } },
      { $set: { adminHidden: true } }
    );
    res.json({ deleted: true, count: result.modifiedCount });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
