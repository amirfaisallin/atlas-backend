import type { Request, Response } from 'express';
import {
  withdrawalRequestsCollection,
  transactionsCollection,
  verificationCodesCollection,
  type WithdrawalRequestDoc,
  type TransactionDoc,
} from './db';
import { getUserById, setUserRealBalance } from './admin-users';
import { generateWithdrawalTransactionId } from './transaction-id';
import { emitAdminNotification } from './admin-socket';

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function randomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** User: request email verification code before withdrawal (step 1) */
export async function handleSendWithdrawalCode(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, email } = req.body as { accountId?: string; email?: string };
    if (!accountId || typeof accountId !== 'string' || !email || typeof email !== 'string') {
      res.status(400).json({ error: 'accountId and email are required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const code = randomCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_EXPIRY_MS).toISOString();
    await verificationCodesCollection().deleteMany({ accountId });
    await verificationCodesCollection().insertOne({
      accountId,
      code,
      email: email.trim().toLowerCase(),
      createdAt: now.toISOString(),
      expiresAt,
    });
    // In production you would send email here (nodemailer etc.). For dev return code.
    res.json({ ok: true, devCode: process.env.NODE_ENV !== 'production' ? code : undefined });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** User: submit withdrawal after email code verification (step 2). Deducts balance, creates pending request. */
export async function handleCreateWithdrawalRequest(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, amount, paymentMethod, address, code } = req.body as {
      accountId?: string;
      amount?: number;
      paymentMethod?: string;
      address?: string;
      code?: string;
    };
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount < 10) {
      res.status(400).json({ error: 'Invalid amount. Minimum $10.' });
      return;
    }
    if (!paymentMethod || typeof paymentMethod !== 'string' || !address || typeof address !== 'string') {
      res.status(400).json({ error: 'paymentMethod and address are required' });
      return;
    }
    if (!code || typeof code !== 'string' || code.length < 4) {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const realBalance = typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
    if (realBalance < numAmount) {
      res.status(400).json({ error: 'Invalid amount. Insufficient balance.', code: 'INSUFFICIENT_BALANCE' });
      return;
    }
    const coll = verificationCodesCollection();
    const codeDoc = await coll.findOne({ accountId, code: code.trim() });
    if (!codeDoc) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }
    const expiresAt = new Date(codeDoc.expiresAt).getTime();
    if (Date.now() > expiresAt) {
      await coll.deleteOne({ _id: codeDoc._id });
      res.status(400).json({ error: 'Verification code has expired' });
      return;
    }
    await coll.deleteOne({ _id: codeDoc._id });

    const id = `WR-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const userTransactionId = await generateWithdrawalTransactionId();
    const now = new Date().toISOString();

    const newBalance = realBalance - numAmount;
    await setUserRealBalance(accountId, newBalance);

    const wrDoc: WithdrawalRequestDoc = {
      id,
      userTransactionId,
      accountId,
      amount: numAmount,
      paymentMethod: paymentMethod.trim(),
      address: address.trim(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await withdrawalRequestsCollection().insertOne(wrDoc as WithdrawalRequestDoc & { _id?: unknown });

    const txDoc: TransactionDoc = {
      id: `TX-W-${id}`,
      userTransactionId,
      accountId,
      type: 'withdrawal',
      referenceId: id,
      amount: numAmount,
      paymentMethod: paymentMethod.trim(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await transactionsCollection().insertOne(txDoc as TransactionDoc & { _id?: unknown });

    emitAdminNotification({
      type: 'withdrawal_request',
      id,
      accountId,
      amount: numAmount,
      paymentMethod: paymentMethod.trim(),
      userName: user.name,
      userEmail: user.email,
    });

    res.status(201).json({
      id,
      userTransactionId,
      message: 'Withdrawal request submitted. It will appear as Pending until admin approves.',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** User: get my withdrawal requests for transaction history */
export async function handleMyWithdrawalRequests(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const docs = await withdrawalRequestsCollection()
      .find({ accountId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ requests: docs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: list all withdrawal requests */
export async function handleListWithdrawalRequests(_req: Request, res: Response): Promise<void> {
  try {
    const docs = await withdrawalRequestsCollection()
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ requests: docs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: accept withdrawal – mark success, transaction already deducted */
export async function handleAcceptWithdrawalRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const wr = await withdrawalRequestsCollection().findOne({ id });
    if (!wr) {
      res.status(404).json({ error: 'Withdrawal request not found' });
      return;
    }
    if (wr.status !== 'pending') {
      res.status(400).json({ error: 'Request is not pending' });
      return;
    }
    const now = new Date().toISOString();
    await withdrawalRequestsCollection().updateOne(
      { id },
      { $set: { status: 'accepted', updatedAt: now, reviewedAt: now } }
    );
    await transactionsCollection().updateOne(
      { referenceId: id, type: 'withdrawal' },
      { $set: { status: 'successful', updatedAt: now } }
    );
    res.json({ ok: true, status: 'accepted' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: reject withdrawal – refund balance, mark failed */
export async function handleRejectWithdrawalRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const wr = await withdrawalRequestsCollection().findOne({ id });
    if (!wr) {
      res.status(404).json({ error: 'Withdrawal request not found' });
      return;
    }
    if (wr.status !== 'pending') {
      res.status(400).json({ error: 'Request is not pending' });
      return;
    }
    const user = await getUserById(wr.accountId);
    const currentBalance = user && typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
    await setUserRealBalance(wr.accountId, currentBalance + wr.amount);

    const now = new Date().toISOString();
    await withdrawalRequestsCollection().updateOne(
      { id },
      { $set: { status: 'rejected', updatedAt: now, reviewedAt: now } }
    );
    await transactionsCollection().updateOne(
      { referenceId: id, type: 'withdrawal' },
      { $set: { status: 'failed', updatedAt: now } }
    );
    res.json({ ok: true, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: delete one withdrawal request. If pending, refunds user balance first. */
export async function handleDeleteWithdrawalRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const wr = await withdrawalRequestsCollection().findOne({ id });
    if (!wr) {
      res.status(404).json({ error: 'Withdrawal request not found' });
      return;
    }
    if (wr.status === 'pending') {
      const user = await getUserById(wr.accountId);
      const currentBalance = user && typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
      await setUserRealBalance(wr.accountId, currentBalance + wr.amount);
    }
    await withdrawalRequestsCollection().deleteOne({ id });
    await transactionsCollection().deleteOne({ referenceId: id, type: 'withdrawal' });
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: delete all withdrawal requests. Pending ones are refunded first. */
export async function handleDeleteAllWithdrawalRequests(_req: Request, res: Response): Promise<void> {
  try {
    const all = await withdrawalRequestsCollection().find({}).toArray();
    for (const wr of all) {
      if (wr.status === 'pending') {
        const user = await getUserById(wr.accountId);
        const currentBalance = user && typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
        await setUserRealBalance(wr.accountId, currentBalance + wr.amount);
      }
    }
    await withdrawalRequestsCollection().deleteMany({});
    await transactionsCollection().deleteMany({ type: 'withdrawal' });
    res.json({ deleted: true, count: all.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
