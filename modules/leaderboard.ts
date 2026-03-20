/**
 * Real-time leaderboard: aggregation from trades, top 10 by P&L, broadcast via Socket.io.
 * Optimized to prevent server lag: single aggregation pipeline, debounced broadcast.
 */

import type { Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { tradesCollection } from './db';
import { getUserById } from './admin-users';
import { getAdminSocket } from './admin-socket';

const MAX_USERS_FOR_RANK = 2000;

/**
 * Daily reset window for leaderboard – Bangladesh time (UTC+6).
 * প্রতি দিন বাংলাদেশ সময় রাত ২:০০ থেকে পরের দিন রাত ১:৫৯:৫৯ পর্যন্ত ট্রেডগুলোই লিডারবোর্ডে গণনা হবে।
 * মানে ২টা বাজতেই পুরোনো দিনের সব প্রফিট মুছে নতুন করে লিডারবোর্ড শুরু হবে।
 */
function getDhakaDailyCutoffIso(): string {
  const nowUtc = new Date();
  // Convert to Asia/Dhaka approximate time (UTC+6). This ignores DST which Bangladesh does not use normally.
  const nowDhakaMs = nowUtc.getTime() + 6 * 60 * 60 * 1000;
  const dhakaNow = new Date(nowDhakaMs);

  const year = dhakaNow.getUTCFullYear();
  const month = dhakaNow.getUTCMonth();
  const date = dhakaNow.getUTCDate();

  const cutoffDhaka = new Date(Date.UTC(year, month, date, 2, 0, 0, 0)); // 02:00 Dhaka
  // যদি এখন ২টার আগে হয়, তাহলে আগের দিনের ২টা থেকে কাউন্ট হবে (মানে আজ রাত ২টায় নতুন দিন শুরু হবে)
  if (dhakaNow < cutoffDhaka) {
    cutoffDhaka.setUTCDate(cutoffDhaka.getUTCDate() - 1);
  }

  const cutoffUtcMs = cutoffDhaka.getTime() - 6 * 60 * 60 * 1000;
  return new Date(cutoffUtcMs).toISOString();
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  name: string;
  pnl: number;
  /** Cloudinary profile photo URL – প্রোফাইলে সেট করা ফটো র‍্যাংকিং এ দেখায় */
  profilePhoto?: string | null;
}

export interface LeaderboardResponse {
  top10: LeaderboardEntry[];
  /** Sorted by pnl desc for client to compute any user's rank */
  allPnl: Array<{ userId: string; pnl: number }>;
}

export interface LeaderboardUserPnlEnrichedEntry {
  userId: string;
  pnl: number;
  name: string;
  profilePhoto?: string | null;
}

export interface LeaderboardUserStats {
  rank: number | null;
  pnl: number;
  positionsToTop10: number;
  totalUsers: number;
}

let broadcastDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const BROADCAST_DEBOUNCE_MS = 300;

/**
 * P&L per trade: won = amount * (profitability/100), lost = -amount, refund = 0.
 * Uses aggregation for performance.
 */
function pnlExpr() {
  return {
    $switch: {
      branches: [
        {
          case: { $eq: ['$trade.status', 'won'] },
          then: {
            $multiply: [
              '$trade.amount',
              { $divide: [{ $ifNull: ['$trade.profitability', 91] }, 100] },
            ],
          },
        },
        {
          case: { $eq: ['$trade.status', 'lost'] },
          then: { $multiply: ['$trade.amount', -1] },
        },
      ],
      default: 0,
    },
  };
}

/**
 * Get a single user's total P&L (for "Your position" – can be negative).
 */
export async function getUserPnl(accountId: string): Promise<number> {
  const coll = tradesCollection();
  const cutoffIso = getDhakaDailyCutoffIso();
  const cutoffDate = new Date(cutoffIso);
  const cursor = coll.aggregate<{ pnl: number }>([
    {
      $match: {
        userId: accountId,
        // createdAt may be string or Date depending on how trades were inserted.
        // $toDate makes it robust for both cases.
        $expr: { $gte: [{ $toDate: '$createdAt' }, cutoffDate] },
        $or: [{ accountType: 'real' }, { accountType: { $exists: false } }],
      },
    },
    { $group: { _id: null, pnl: { $sum: pnlExpr() } } },
    { $project: { pnl: 1, _id: 0 } },
  ]);
  const doc = await cursor.next();
  return doc?.pnl ?? 0;
}

/**
 * Aggregation: group by userId, sum P&L. রেংকিংয়ে শুধু প্রফিট করা ইউজার (pnl > 0); লস করা ইউজার লিস্টে দেখাবে না।
 * Returns top 10 (profit only) with names and list of profitable users for rank.
 */
export async function getLeaderboard(): Promise<LeaderboardResponse> {
  const coll = tradesCollection();
  const cutoffIso = getDhakaDailyCutoffIso();
  const cutoffDate = new Date(cutoffIso);

  const matchStage = {
    $match: {
      $expr: { $gte: [{ $toDate: '$createdAt' }, cutoffDate] },
      $or: [{ accountType: 'real' }, { accountType: { $exists: false } }],
    },
  };

  const groupStage = {
    $group: {
      _id: '$userId',
      pnl: { $sum: pnlExpr() },
    },
  };

  const sortStage = { $sort: { pnl: -1 } };
  // Leaderboard ranking by total P&L (profit and loss included)
  const allCursor = coll.aggregate<{ userId: string; pnl: number }>([
    matchStage,
    groupStage,
    sortStage,
    { $limit: MAX_USERS_FOR_RANK },
    { $project: { userId: '$_id', pnl: 1, _id: 0 } },
  ]);
  const allPnl = await allCursor.toArray();

  // Top 10 ranked by total P&L (profit and loss included) – with user names
  const top10Cursor = coll.aggregate<{ _id: string; pnl: number }>([
    matchStage,
    groupStage,
    sortStage,
    { $limit: 10 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: 'id',
        as: 'user',
      },
    },
    {
      $project: {
        userId: '$_id',
        pnl: 1,
        name: {
          $let: {
            vars: { u: { $arrayElemAt: ['$user', 0] } },
            in: { $ifNull: ['$$u.name', 'Unknown'] },
          },
        },
        profilePhoto: {
          $let: {
            vars: { u: { $arrayElemAt: ['$user', 0] } },
            in: '$$u.profilePhoto',
          },
        },
      },
    },
  ]);
  const top10Raw = await top10Cursor.toArray();

  const top10: LeaderboardEntry[] = top10Raw.map((row, i) => {
    const u = row as { name?: string; profilePhoto?: string | null };
    return {
      rank: i + 1,
      userId: row._id,
      name: u.name ?? 'Unknown',
      pnl: row.pnl,
      profilePhoto: u.profilePhoto ?? null,
    };
  });

  return { top10, allPnl };
}

/** সব ইউজার (প্রফিট + লস) P&L অনুযায়ী সর্ট – শুধু "Your position" এ পজিশন নম্বর দেয়ার জন্য */
const MAX_USERS_GLOBAL = 5000;

export async function getAllUsersPnlSorted(): Promise<Array<{ userId: string; pnl: number }>> {
  const coll = tradesCollection();
  const cutoffIso = getDhakaDailyCutoffIso();
  const cutoffDate = new Date(cutoffIso);
  const matchStage = {
    $match: {
      $expr: { $gte: [{ $toDate: '$createdAt' }, cutoffDate] },
      $or: [{ accountType: 'real' }, { accountType: { $exists: false } }],
    },
  };
  const groupStage = { $group: { _id: '$userId', pnl: { $sum: pnlExpr() } } };
  const cursor = coll.aggregate<{ userId: string; pnl: number }>([
    matchStage,
    groupStage,
    { $sort: { pnl: -1 } },
    { $limit: MAX_USERS_GLOBAL },
    { $project: { userId: '$_id', pnl: 1, _id: 0 } },
  ]);
  return cursor.toArray();
}

/**
 * Admin: same ranking (all users: profit + loss) but enriched with user name + profile photo.
 * Used for leaderboard page "full control" (details view).
 */
export async function getAllUsersPnlSortedEnriched(): Promise<LeaderboardUserPnlEnrichedEntry[]> {
  const coll = tradesCollection();
  const cutoffIso = getDhakaDailyCutoffIso();

  const matchStage = {
    $match: {
      createdAt: { $gte: cutoffIso },
      $or: [{ accountType: 'real' }, { accountType: { $exists: false } }],
    },
  };

  const groupStage = { $group: { _id: '$userId', pnl: { $sum: pnlExpr() } } };

  const cursor = coll.aggregate<LeaderboardUserPnlEnrichedEntry>([
    matchStage,
    groupStage,
    { $sort: { pnl: -1 } },
    { $limit: MAX_USERS_GLOBAL },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: 'id',
        as: 'user',
      },
    },
    {
      $project: {
        userId: '$_id',
        pnl: 1,
        name: {
          $let: {
            vars: { u: { $arrayElemAt: ['$user', 0] } },
            in: { $ifNull: ['$$u.name', 'Unknown'] },
          },
        },
        profilePhoto: {
          $let: {
            vars: { u: { $arrayElemAt: ['$user', 0] } },
            in: { $ifNull: ['$$u.profilePhoto', null] },
          },
        },
      },
    },
  ]);

  return cursor.toArray();
}

/**
 * Viewing user এর স্ট্যাটস: পজিশন সব ইউজারের মধ্যে (লস হলেও পজিশন কাউন্ট), প্রফিট করলে টপ ১০ এর দূরত্ব।
 * রেংকিং লিস্টে (top10) সব ইউজারই তাদের P&L অনুযায়ী দেখানো হয়।
 */
export async function getUserStats(
  data: LeaderboardResponse,
  accountId: string | null,
  myPnl: number
): Promise<LeaderboardUserStats> {
  const totalUsers = data.allPnl.length;
  if (!accountId) {
    return { rank: null, pnl: myPnl, positionsToTop10: 0, totalUsers };
  }
  const allUsers = await getAllUsersPnlSorted();
  const globalIdx = allUsers.findIndex((r) => r.userId === accountId);
  const rank = globalIdx >= 0 ? globalIdx + 1 : null;
  const idxInRankList = data.allPnl.findIndex((r) => r.userId === accountId);
  const positionsToTop10 = idxInRankList >= 0 && idxInRankList + 1 > 10 ? idxInRankList + 1 - 10 : 0;
  return { rank, pnl: myPnl, positionsToTop10, totalUsers };
}

/** GET /api/leaderboard?accountId=xxx – top 10 (profit only) + viewing user's position (সব ইউজারের মধ্যে), P&L + প্রোফাইল নাম */
export async function handleGetLeaderboard(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() || null : null;
    const data = await getLeaderboard();
    const myPnl = accountId ? await getUserPnl(accountId) : 0;
    const stats = await getUserStats(data, accountId, myPnl);
    let myName: string | null = null;
    if (accountId) {
      const user = await getUserById(accountId);
      myName = user?.name?.trim() ?? null;
    }
    res.json({
      top10: data.top10,
      allPnl: data.allPnl,
      myRank: stats.rank,
      myPnl: stats.pnl,
      myName: myName ?? undefined,
      positionsToTop10: stats.positionsToTop10,
      totalUsers: stats.totalUsers,
    });
  } catch (e) {
    console.error('[Leaderboard] GET failed:', e);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
}

export interface AdminLeaderboardResponse {
  top10: LeaderboardEntry[];
  allUsers: LeaderboardUserPnlEnrichedEntry[];
  cutoffIso: string;
  generatedAt: string;
}

/**
 * Admin: GET /api/admin/leaderboard
 * Returns enriched leaderboard data (top10 + all users) for full control.
 */
export async function handleAdminGetLeaderboard(_req: Request, res: Response): Promise<void> {
  try {
    const [lb, allUsers] = await Promise.all([getLeaderboard(), getAllUsersPnlSortedEnriched()]);
    res.json({
      top10: lb.top10,
      allUsers,
      cutoffIso: getDhakaDailyCutoffIso(),
      generatedAt: new Date().toISOString(),
    } satisfies AdminLeaderboardResponse);
  } catch (e) {
    console.error('[Leaderboard][Admin] GET failed:', e);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
}

/**
 * Admin: POST /api/admin/leaderboard/recompute
 * Forces recompute + broadcast now (instead of waiting for debounce).
 */
export async function handleAdminRecomputeLeaderboard(_req: Request, res: Response): Promise<void> {
  try {
    const socket = getAdminSocket();
    const data = await getLeaderboard();
    if (socket) socket.emit('leaderboard', data);
    res.json({ ok: true, emittedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[Leaderboard][Admin] recompute failed:', e);
    res.status(500).json({ error: 'Failed to recompute leaderboard' });
  }
}

/**
 * Recompute leaderboard and broadcast to all connected clients. Debounced to avoid lag on rapid updates.
 */
export function scheduleLeaderboardBroadcast(io: SocketIOServer | null): void {
  if (!io) return;
  if (broadcastDebounceTimer) clearTimeout(broadcastDebounceTimer);
  broadcastDebounceTimer = setTimeout(async () => {
    broadcastDebounceTimer = null;
    try {
      const data = await getLeaderboard();
      io.emit('leaderboard', data);
    } catch (err) {
      console.error('[Leaderboard] Broadcast failed:', err);
    }
  }, BROADCAST_DEBOUNCE_MS);
}
