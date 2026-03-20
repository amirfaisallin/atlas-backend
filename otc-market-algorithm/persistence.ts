/**
 * OTC Market Algorithm – batch persist OHLC to MongoDB every 60 seconds
 */

import type { Collection } from 'mongodb';
import { getDb } from '../modules/db.js';
import type { CandleTick } from './types.js';

export interface OTCohlcDoc {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  granularity: number;
}

let otcOhlcCollection: Collection<OTCohlcDoc> | null = null;

export function getOtcOhlcCollection(): Collection<OTCohlcDoc> | null {
  if (otcOhlcCollection) return otcOhlcCollection;
  const db = getDb();
  if (!db) return null;
  otcOhlcCollection = db.collection<OTCohlcDoc>('otc_ohlc');
  return otcOhlcCollection;
}

/** Batch insert OHLC candles (one per symbol) for a given granularity in seconds. */
export async function persistOtcCandles(
  items: Array<{ symbol: string; candle: CandleTick }>,
  intervalSec: number
): Promise<void> {
  const coll = getOtcOhlcCollection();
  if (!coll || items.length === 0) return;

  const docs: OTCohlcDoc[] = items.map(({ symbol, candle: c }) => ({
    symbol,
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    granularity: intervalSec,
  }));

  try {
    await coll.insertMany(docs);
  } catch (err) {
    console.error('[OTC] Persist OHLC failed:', err);
  }
}

/** Last candle (OHLC) per symbol – used to resume generation from last recorded point. */
export interface LastCandleRow {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Load the latest 1m candlestick per symbol from MongoDB.
 * Ensures new candles resume from the last recorded point after server restart.
 */
export async function loadLastCandlesPerSymbol(): Promise<Map<string, LastCandleRow>> {
  const coll = getOtcOhlcCollection();
  const result = new Map<string, LastCandleRow>();
  if (!coll) return result;

  try {
    await coll.createIndex({ granularity: 1, time: -1 }).catch(() => {});
    const cursor = coll.aggregate<{ _id: string; time: number; open: number; high: number; low: number; close: number }>([
      { $match: { granularity: 60 } },
      { $sort: { time: -1 } },
      {
        $group: {
          _id: '$symbol',
          time: { $first: '$time' },
          open: { $first: '$open' },
          high: { $first: '$high' },
          low: { $first: '$low' },
          close: { $first: '$close' },
        },
      },
    ]);
    for await (const doc of cursor) {
      result.set(doc._id, {
        symbol: doc._id,
        time: doc.time,
        open: doc.open,
        high: doc.high,
        low: doc.low,
        close: doc.close,
      });
    }
  } catch (err) {
    console.error('[OTC] Load last candles failed:', err);
  }
  return result;
}

/** Load last close per symbol (backward compatibility). Prefer loadLastCandlesPerSymbol for full continuity. */
export async function loadLastCloses(): Promise<Map<string, number>> {
  const lastCandles = await loadLastCandlesPerSymbol();
  const result = new Map<string, number>();
  for (const [symbol, row] of lastCandles) {
    result.set(symbol, row.close);
  }
  return result;
}

/** Single candle row for historic load (time-ordered). */
export interface HistoricCandleRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const DEFAULT_HISTORIC_LIMIT = 2000;

/**
 * Load the full historic candlestick sequence per symbol from MongoDB for a given timeframe.
 * Returns candles oldest-first. Used on startup to pre-fill the store so every timeframe
 * has complete, uninterrupted history when the user switches (5s, 10s, 15s, 30s, 1m, etc.).
 */
export async function loadHistoricCandlesPerSymbol(
  limit: number = DEFAULT_HISTORIC_LIMIT,
  intervalSec: number = 60
): Promise<Map<string, HistoricCandleRow[]>> {
  const coll = getOtcOhlcCollection();
  const result = new Map<string, HistoricCandleRow[]>();
  if (!coll) return result;

  try {
    await coll.createIndex({ symbol: 1, granularity: 1, time: 1 }).catch(() => {});
    const cursor = coll.aggregate<
      { _id: string; candles: { time: number; open: number; high: number; low: number; close: number }[] }
    >([
      { $match: { granularity: intervalSec } },
      { $sort: { symbol: 1, time: 1 } },
      {
        $group: {
          _id: '$symbol',
          candles: {
            $push: {
              time: '$time',
              open: '$open',
              high: '$high',
              low: '$low',
              close: '$close',
            },
          },
        },
      },
      { $project: { candles: { $slice: ['$candles', -limit] } } },
    ]);
    for await (const doc of cursor) {
      const rows: HistoricCandleRow[] = (doc.candles ?? []).map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      result.set(doc._id, rows);
    }
  } catch (err) {
    console.error('[OTC] Load historic candles failed:', err);
  }
  return result;
}
