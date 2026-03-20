import type { Request, Response } from 'express';
import { getDb } from './db';
import { tradesCollection } from './db';
import { OTC_SYMBOLS } from '../otc-market-algorithm/constants.js';

const COLLECTION = 'site_content';
const DOC_ID = 'market_visibility';

/** Default profitability for OTC markets. */
const OTC_DEFAULT_PROFITABILITY = 85;

const ALL_REAL_PAIRS = [
  'XAU/USD', 'BTC/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD',
  'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'EUR/CHF', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD', 'GBP/CHF', 'GBP/AUD',
  'GBP/CAD', 'GBP/NZD', 'AUD/JPY', 'AUD/NZD', 'AUD/CAD', 'AUD/CHF', 'CAD/JPY', 'CHF/JPY', 'NZD/JPY',
  'NZD/CAD', 'NZD/CHF', 'CAD/CHF', 'USD/SEK', 'USD/NOK',
];

const DEFAULT_PROFITABILITY: Record<string, number> = {
  'XAU/USD': 90, 'BTC/USD': 89, 'EUR/USD': 91, 'GBP/USD': 85, 'USD/JPY': 88, 'USD/CHF': 82,
  'AUD/USD': 87, 'USD/CAD': 84, 'NZD/USD': 79, 'EUR/GBP': 86, 'EUR/JPY': 83, 'GBP/JPY': 81,
  'EUR/CHF': 84, 'EUR/AUD': 82, 'EUR/CAD': 83, 'EUR/NZD': 80, 'GBP/CHF': 85, 'GBP/AUD': 83,
  'GBP/CAD': 84, 'GBP/NZD': 81, 'AUD/JPY': 86, 'AUD/NZD': 82, 'AUD/CAD': 83, 'AUD/CHF': 81,
  'CAD/JPY': 85, 'CHF/JPY': 84, 'NZD/JPY': 82, 'NZD/CAD': 80, 'NZD/CHF': 79, 'CAD/CHF': 82,
  'USD/SEK': 81, 'USD/NOK': 80,
};

export interface TraderStats {
  pair: string;
  totalTraders: number;
  upTraders: number;
  downTraders: number;
}

/** Per-pair trader counts: unique users; UP = users with at least one higher trade, DOWN = at least one lower. */
async function getTraderStats(): Promise<TraderStats[]> {
  try {
    if (!getDb()) return ALL_REAL_PAIRS.map((pair) => ({ pair, totalTraders: 0, upTraders: 0, downTraders: 0 }));
    const coll = tradesCollection();
    const pipeline = [
      { $match: { 'trade.pair': { $exists: true, $in: ALL_REAL_PAIRS } } },
      { $group: { _id: { pair: '$trade.pair', userId: '$userId' }, types: { $addToSet: '$trade.type' } } },
      {
        $group: {
          _id: '$_id.pair',
          upTraders: { $sum: { $cond: [{ $in: ['higher', '$types'] }, 1, 0] } },
          downTraders: { $sum: { $cond: [{ $in: ['lower', '$types'] }, 1, 0] } },
          totalTraders: { $sum: 1 },
        },
      },
      { $project: { pair: '$_id', upTraders: 1, downTraders: 1, totalTraders: 1, _id: 0 } },
    ];
    const result = await coll.aggregate(pipeline).toArray();
    const byPair = new Map<string, TraderStats>();
    for (const r of result as { pair: string; upTraders: number; downTraders: number; totalTraders: number }[]) {
      byPair.set(r.pair, {
        pair: r.pair,
        totalTraders: r.totalTraders ?? 0,
        upTraders: r.upTraders ?? 0,
        downTraders: r.downTraders ?? 0,
      });
    }
    return ALL_REAL_PAIRS.map((pair) => byPair.get(pair) ?? { pair, totalTraders: 0, upTraders: 0, downTraders: 0 });
  } catch {
    return ALL_REAL_PAIRS.map((pair) => ({ pair, totalTraders: 0, upTraders: 0, downTraders: 0 }));
  }
}

function getProfitability(pair: string, doc: { profitability?: Record<string, number> } | null): number {
  const p = doc?.profitability && typeof doc.profitability[pair] === 'number' ? doc.profitability[pair] : null;
  return p != null ? p : (DEFAULT_PROFITABILITY[pair] ?? 80);
}

/** Step sizes for auto-adjust (up/down). Minimum change 1%; no sub-1% moves. */
const AUTO_STEPS = [-10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10];

/** Auto-adjust bounds: never below 30% or above 95%. */
const AUTO_ADJUST_MIN = 30;
const AUTO_ADJUST_MAX = 95;

/** Simple hash from string to integer for deterministic time-based phase. */
function hashPhase(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Apply time-based step offset so market % moves up/down periodically (e.g. every few minutes). */
function applyTimeStepVariation(percent: number, pair: string, intervalMinutes: number): number {
  const bucket = Math.floor(Date.now() / (intervalMinutes * 60 * 1000));
  const idx = hashPhase(`${pair}-${bucket}`) % AUTO_STEPS.length;
  const step = AUTO_STEPS[idx];
  return Math.max(AUTO_ADJUST_MIN, Math.min(AUTO_ADJUST_MAX, Math.round(percent + step)));
}

/** Apply auto-decrease: more traders → lower percentage. Result is whole % only; min change 1%. */
function applyAutoDecrease(
  basePercent: number,
  totalTraders: number,
  decreasePerTrader: number
): number {
  const reduction = totalTraders * decreasePerTrader;
  const value = Math.round(basePercent - reduction);
  return Math.max(AUTO_ADJUST_MIN, Math.min(AUTO_ADJUST_MAX, value));
}

/** Public: enabled markets with profitability (user profit %). If autoDecrease on, adjusted by trader count. */
export async function handleGetEnabled(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.json({
        real: ALL_REAL_PAIRS.map((pair) => ({
          pair,
          profitability: Math.round(DEFAULT_PROFITABILITY[pair] ?? 80),
        })),
        otc: OTC_SYMBOLS.map((pair) => ({ pair, profitability: OTC_DEFAULT_PROFITABILITY })),
      });
      return;
    }
    const doc = await db.collection(COLLECTION).findOne({ id: DOC_ID });
    const enabledReal = Array.isArray(doc?.enabledReal) ? doc.enabledReal : ALL_REAL_PAIRS;
    const enabledOtc = Array.isArray(doc?.enabledOtc) ? doc.enabledOtc : OTC_SYMBOLS.slice();
    const autoDecrease = !!doc?.autoDecreaseByTraders;
    const decreasePerTrader = typeof doc?.decreasePerTrader === 'number' && doc.decreasePerTrader >= 0
      ? doc.decreasePerTrader
      : 0.1;
    let traderStats: TraderStats[] = [];
    if (autoDecrease) traderStats = await getTraderStats();
    const statsByPair = new Map(traderStats.map((s) => [s.pair, s]));
    const real = enabledReal.map((pair: string) => {
      let profitability = getProfitability(pair, doc);
      if (autoDecrease) {
        const stats = statsByPair.get(pair);
        const total = stats?.totalTraders ?? 0;
        profitability = applyAutoDecrease(profitability, total, decreasePerTrader);
        profitability = applyTimeStepVariation(profitability, pair, 3);
      }
      return { pair, profitability: Math.round(profitability) };
    });
    const otc = enabledOtc.map((pair: string) => ({
      pair,
      profitability:
        typeof doc?.profitability?.[pair] === 'number'
          ? Math.round(doc.profitability[pair])
          : OTC_DEFAULT_PROFITABILITY,
    }));
    res.json({ real, otc });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: list + enabled + profitability + auto-decrease settings + trader stats per market. */
export async function handleAdminGet(_req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    let enabledReal: string[] = ALL_REAL_PAIRS;
    let enabledOtc: string[] = OTC_SYMBOLS.slice();
    let profitability: Record<string, number> = {};
    let autoDecreaseByTraders = false;
    let decreasePerTrader = 0.1;
    if (db) {
      const doc = await db.collection(COLLECTION).findOne({ id: DOC_ID });
      if (Array.isArray(doc?.enabledReal)) enabledReal = doc.enabledReal;
      if (Array.isArray(doc?.enabledOtc)) enabledOtc = doc.enabledOtc;
      if (doc?.profitability && typeof doc.profitability === 'object') profitability = doc.profitability;
      if (typeof doc?.autoDecreaseByTraders === 'boolean') autoDecreaseByTraders = doc.autoDecreaseByTraders;
      if (typeof doc?.decreasePerTrader === 'number' && doc.decreasePerTrader >= 0) decreasePerTrader = doc.decreasePerTrader;
    }
    const traderStats = await getTraderStats();
    res.json({
      real: ALL_REAL_PAIRS,
      otc: OTC_SYMBOLS,
      enabledReal,
      enabledOtc,
      profitability,
      autoDecreaseByTraders,
      decreasePerTrader,
      traderStats,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: save enabled list, profitability per pair, and auto-decrease settings. */
export async function handleAdminPut(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }
    const enabledReal = Array.isArray(req.body?.enabledReal)
      ? req.body.enabledReal.filter((p: unknown) => typeof p === 'string')
      : ALL_REAL_PAIRS;
    const enabledOtc = Array.isArray(req.body?.enabledOtc)
      ? req.body.enabledOtc.filter((p: unknown) => typeof p === 'string')
      : OTC_SYMBOLS.slice();
    const profitability =
      req.body?.profitability && typeof req.body.profitability === 'object'
        ? req.body.profitability
        : {};
    const autoDecreaseByTraders = !!req.body?.autoDecreaseByTraders;
    const decreasePerTrader =
      typeof req.body?.decreasePerTrader === 'number' && req.body.decreasePerTrader >= 0
        ? req.body.decreasePerTrader
        : 0.1;
    const existing = await db.collection(COLLECTION).findOne({ id: DOC_ID });
    const existingProfit =
      existing?.profitability && typeof existing.profitability === 'object'
        ? (existing.profitability as Record<string, number>)
        : {};
    const cleanProfit: Record<string, number> = {};
    const allPairs = [...ALL_REAL_PAIRS, ...OTC_SYMBOLS];
    for (const pair of allPairs) {
      const v = profitability[pair];
      if (typeof v === 'number' && !Number.isNaN(v) && v >= 1 && v <= 100) {
        cleanProfit[pair] = v;
      } else if (typeof existingProfit[pair] === 'number') {
        cleanProfit[pair] = existingProfit[pair];
      } else if (DEFAULT_PROFITABILITY[pair] != null) {
        cleanProfit[pair] = DEFAULT_PROFITABILITY[pair]!;
      } else {
        cleanProfit[pair] = OTC_DEFAULT_PROFITABILITY;
      }
    }
    await db.collection(COLLECTION).updateOne(
      { id: DOC_ID },
      {
        $set: {
          id: DOC_ID,
          enabledReal,
          enabledOtc,
          profitability: cleanProfit,
          autoDecreaseByTraders,
          decreasePerTrader,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
    res.json({ ok: true, enabledReal, enabledOtc, profitability: cleanProfit, autoDecreaseByTraders, decreasePerTrader });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
