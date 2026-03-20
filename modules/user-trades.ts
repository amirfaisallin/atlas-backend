import type { Request, Response } from 'express';
import { getUserById, setUserRealBalance } from './admin-users';
import { getAdminSocket } from './admin-socket';
import { scheduleLeaderboardBroadcast } from './leaderboard';
import { tradesCollection } from './db';

/** Stored trade shape (same as frontend settled trade – no pending). */
export interface StoredTrade {
  id: string;
  type: 'higher' | 'lower';
  amount: number;
  entryPrice: number;
  entryTime: number;
  expiryTime: number;
  status: 'won' | 'lost' | 'refund';
  /** User balance when trade was placed – for admin: "Bybel's Son" (trades >50% of balance) */
  balanceAtTrade?: number;
  pair?: string;
  flag1?: string;
  flag2?: string;
  profitability?: number;
  candleDurationMs?: number;
}

/** শুধু রিয়েল অ্যাকাউন্টের ট্রেড ডাটাবেজে সেভ। ব্যালেন্স আগে আপডেট, তারপর ট্রেড সেভ। */
export async function handleRecordTrade(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, trade, currentBalance, accountType } = req.body as {
      accountId?: string;
      trade?: StoredTrade;
      currentBalance?: number;
      accountType?: string;
    };
    if (!accountId || typeof accountId !== 'string' || !trade || typeof trade !== 'object') {
      res.status(400).json({ error: 'accountId and trade are required' });
      return;
    }
    if (accountType === 'demo') {
      res.status(201).json({ ok: true });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (typeof currentBalance === 'number' && Number.isFinite(currentBalance) && currentBalance >= 0) {
      await setUserRealBalance(accountId, currentBalance);
    }
    const balanceAtTrade =
      typeof (trade as { balanceAtPlace?: number }).balanceAtPlace === 'number'
        ? (trade as { balanceAtPlace: number }).balanceAtPlace
        : undefined;
    const t: StoredTrade = {
      id: trade.id,
      type: trade.type,
      amount: Number(trade.amount) || 0,
      entryPrice: Number(trade.entryPrice) || 0,
      entryTime: Number(trade.entryTime) || 0,
      expiryTime: Number(trade.expiryTime) || 0,
      status: trade.status === 'won' || trade.status === 'lost' || trade.status === 'refund' ? trade.status : 'lost',
      balanceAtTrade,
      pair: typeof trade.pair === 'string' ? trade.pair : undefined,
      flag1: typeof trade.flag1 === 'string' ? trade.flag1 : undefined,
      flag2: typeof trade.flag2 === 'string' ? trade.flag2 : undefined,
      profitability: typeof trade.profitability === 'number' ? trade.profitability : undefined,
      candleDurationMs: typeof trade.candleDurationMs === 'number' ? trade.candleDurationMs : undefined,
    };
    await tradesCollection().insertOne({
      userId: accountId,
      accountType: 'real',
      trade: t as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
    scheduleLeaderboardBroadcast(getAdminSocket());
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site: get current user's trade history from DB (for Analytics – same data as admin). */
export async function handleGetMyTrades(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const cursor = tradesCollection()
      .find({ userId: accountId, $or: [{ accountType: 'real' }, { accountType: { $exists: false } }] })
      .sort({ createdAt: -1 });
    const docs = await cursor.toArray();
    const trades: StoredTrade[] = docs.map((d) => d.trade as unknown as StoredTrade);
    res.json({ trades });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: ইউজারের রিয়েল অ্যাকাউন্ট ট্রেড (MongoDB থেকে)। পুরনো ডেটায় accountType নাও থাকতে পারে তাই userId দিয়েই খোঁজা। */
export async function handleGetUserTrades(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const cursor = tradesCollection()
      .find({ userId: id, $or: [{ accountType: 'real' }, { accountType: { $exists: false } }] })
      .sort({ createdAt: -1 });
    const docs = await cursor.toArray();
    const trades: StoredTrade[] = docs.map((d) => d.trade as unknown as StoredTrade);
    res.json({ trades });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
