/**
 * OTC Market Algorithm – in-memory store
 * Holds latest tick per symbol and aggregated candles for all timeframes (5s–1d).
 */

import type { CandleTick, OHLC } from './types.js';
import { OTC_SYMBOLS } from './constants.js';
import { createGenerator } from './MarketGenerator.js';

/** All supported candle intervals in seconds (5s through 1d). */
const GRANULARITIES = [
  5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400,
] as const;

interface CandleBucket {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number; // period start (aligned)
}

/** Align timestamp to period start so each candle closes exactly every intervalSeconds. */
function alignTime(ms: number, intervalSeconds: number): number {
  const s = Math.floor(ms / 1000);
  return (s - (s % intervalSeconds)) * 1000;
}

export class OTCStore {
  /** Latest tick per symbol: { time, price } where price = close */
  private latestTick = new Map<string, { time: number; price: number }>();

  /** Per-symbol generator */
  private generators = new Map<string, ReturnType<typeof createGenerator>>();

  /** Current (incomplete) candle per symbol per granularity */
  private currentCandles = new Map<string, Map<number, CandleBucket>>();

  /** Completed candles per symbol per granularity (ring buffer, e.g. last 500) */
  private completedCandles = new Map<string, Map<number, CandleTick[]>>();

  private readonly maxCandlesPerGranularity = 2000;

  constructor() {
    for (const symbol of OTC_SYMBOLS) {
      this.generators.set(symbol, createGenerator(symbol, 0));
      this.currentCandles.set(symbol, new Map());
      this.completedCandles.set(symbol, new Map(GRANULARITIES.map((g) => [g, []])));
    }
    // Initialize current buckets from first tick (done on first tick)
  }

  /**
   * Generate and store one tick for all symbols.
   * @param nowMs - Current time (ms)
   * @param ohlcOverride - Optional: (symbol, ohlc, nowMs, getPeriodOpen?) => OHLC; getPeriodOpen(intervalSec) returns period open for that interval (multi-timeframe manipulation).
   */
  tick(
    nowMs: number,
    ohlcOverride?: (symbol: string, ohlc: OHLC, nowMs: number, getPeriodOpen?: (intervalSec: number) => number | undefined) => OHLC
  ): Array<{ symbol: string; time: number; price: number; ohlc: OHLC }> {
    const results: Array<{ symbol: string; time: number; price: number; ohlc: OHLC }> = [];

    for (const symbol of OTC_SYMBOLS) {
      const gen = this.generators.get(symbol)!;
      let ohlc = gen.nextTick(nowMs);
      if (ohlcOverride) {
        const cur = this.currentCandles.get(symbol)!;
        const getPeriodOpen = (intervalSec: number): number | undefined => {
          const bucket = cur.get(intervalSec);
          const periodStart = alignTime(nowMs, intervalSec);
          return bucket && bucket.time === periodStart ? bucket.open : undefined;
        };
        const over = ohlcOverride(symbol, ohlc, nowMs, getPeriodOpen);
        if (over) ohlc = over;
      }

      this.latestTick.set(symbol, { time: nowMs, price: ohlc.close });

      const cur = this.currentCandles.get(symbol)!;
      const comp = this.completedCandles.get(symbol)!;

      for (const intervalSec of GRANULARITIES) {
        const periodStart = alignTime(nowMs, intervalSec);
        let bucket = cur.get(intervalSec);
        if (!bucket || bucket.time !== periodStart) {
          if (bucket) {
            const closed: CandleTick = {
              time: bucket.time,
              open: bucket.open,
              high: bucket.high,
              low: bucket.low,
              close: bucket.close,
            };
            const arr = comp.get(intervalSec)!;
            arr.push(closed);
            if (arr.length > this.maxCandlesPerGranularity) arr.shift();
          }
          bucket = {
            time: periodStart,
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
          };
          cur.set(intervalSec, bucket);
        } else {
          bucket.high = Math.max(bucket.high, ohlc.high);
          bucket.low = Math.min(bucket.low, ohlc.low);
          bucket.close = ohlc.close;
        }
      }

      results.push({
        symbol,
        time: nowMs,
        price: ohlc.close,
        ohlc,
      });
    }

    return results;
  }

  /** Get latest price for symbol (for /price API). */
  getPrice(symbol: string): { price: number; time: number } | null {
    const t = this.latestTick.get(symbol);
    return t ? { price: t.price, time: t.time } : null;
  }

  /** Minimum candles for short timeframes before we expand from 1m so the chart looks full (e.g. 5s: 12/min). */
  private static readonly MIN_CANDLES_SHORT_TF = 120;
  /** Short timeframes that can be filled from 1m when we have few native candles. */
  private static readonly SHORT_TF_SEC = [5, 10, 15, 30];

  /** Get candles for symbol and granularity. For 5s/10s/15s/30s, fills from 1m history when native data is scarce so the chart shows many candles. */
  getCandles(
    symbol: string,
    intervalSeconds: number,
    options?: { count?: number; from?: number; to?: number }
  ): CandleTick[] {
    const cur = this.currentCandles.get(symbol)?.get(intervalSeconds);
    const comp = this.completedCandles.get(symbol)?.get(intervalSeconds) ?? [];
    let list: CandleTick[] = [...comp];
    if (cur) {
      list.push({
        time: cur.time,
        open: cur.open,
        high: cur.high,
        low: cur.low,
        close: cur.close,
      });
    }
    list.sort((a, b) => a.time - b.time);

    const count = options?.count ?? 2000;
    const from = options?.from;
    const to = options?.to;

    if (
      list.length < OTCStore.MIN_CANDLES_SHORT_TF &&
      OTCStore.SHORT_TF_SEC.includes(intervalSeconds)
    ) {
      const comp1m = this.completedCandles.get(symbol)?.get(60) ?? [];
      const cur1m = this.currentCandles.get(symbol)?.get(60);
      const list1m: CandleTick[] = [...comp1m];
      if (cur1m) {
        list1m.push({
          time: cur1m.time,
          open: cur1m.open,
          high: cur1m.high,
          low: cur1m.low,
          close: cur1m.close,
        });
      }
      list1m.sort((a, b) => a.time - b.time);
      const firstShortTime = list.length > 0 ? list[0].time : Infinity;
      const subPerMinute = 60 / intervalSeconds;
      const expanded: CandleTick[] = [];
      for (const m of list1m) {
        if (m.time + 60_000 > firstShortTime) break;
        for (let i = 0; i < subPerMinute; i++) {
          const t = m.time + i * intervalSeconds * 1000;
          expanded.push({
            time: t,
            open: m.open,
            high: m.high,
            low: m.low,
            close: m.close,
          });
        }
      }
      list = [...expanded, ...list];
    }

    if (from != null || to != null) {
      list = list.filter((c) => {
        if (from != null && c.time < from) return false;
        if (to != null && c.time > to) return false;
        return true;
      });
    }
    return list.slice(-count);
  }

  /** Get last completed 1-minute candle per symbol (for batch persist). */
  getLastCompletedMinuteCandles(): Array<{ symbol: string; candle: CandleTick }> {
    return this.getLastCompletedCandles(60);
  }

  /** Get last completed candle per symbol for any interval (for multi-timeframe persist). */
  getLastCompletedCandles(intervalSec: number): Array<{ symbol: string; candle: CandleTick }> {
    const out: Array<{ symbol: string; candle: CandleTick }> = [];
    for (const symbol of OTC_SYMBOLS) {
      const comp = this.completedCandles.get(symbol)?.get(intervalSec) ?? [];
      const last = comp[comp.length - 1];
      if (last) out.push({ symbol, candle: { ...last } });
    }
    return out;
  }

  /** Get current (possibly incomplete) 1m candle for each symbol – for persistence we persist on period close. */
  getCurrentMinuteBuckets(): Array<{ symbol: string; bucket: CandleBucket }> {
    const out: Array<{ symbol: string; bucket: CandleBucket }> = [];
    for (const symbol of OTC_SYMBOLS) {
      const cur = this.currentCandles.get(symbol)?.get(60);
      if (cur) out.push({ symbol, bucket: { ...cur } });
    }
    return out;
  }

  /**
   * Initialize generator from last recorded candle (e.g. after server restart).
   * Ensures next tick open = this close (no gap). Use full OHLC when loading from DB.
   */
  setLastCandle(symbol: string, open: number, high: number, low: number, close: number): void {
    const gen = this.generators.get(symbol);
    if (gen) gen.setState(open, high, low, close);
  }

  /** Initialize from last close only (backward compatibility). */
  setLastClose(symbol: string, close: number): void {
    this.setLastCandle(symbol, close, close, close, close);
  }

  /**
   * Seed historic candles for any timeframe (e.g. after server restart).
   * Candles must be sorted oldest-first. For 1m only, generator state is updated so generation continues without gap.
   */
  seedHistoricCandles(symbol: string, intervalSec: number, candles: CandleTick[]): void {
    if (candles.length === 0) return;
    const comp = this.completedCandles.get(symbol)?.get(intervalSec);
    if (!comp) return;
    comp.length = 0;
    const toAdd = candles.length > this.maxCandlesPerGranularity
      ? candles.slice(-this.maxCandlesPerGranularity)
      : candles;
    comp.push(...toAdd);
    const last = toAdd[toAdd.length - 1];
    if (intervalSec === 60) {
      this.setLastCandle(symbol, last.open, last.high, last.low, last.close);
      this.latestTick.set(symbol, { time: last.time, price: last.close });
    }
  }

  /** Seed 1m only (updates generator state). */
  seedHistoricCandles1m(symbol: string, candles: CandleTick[]): void {
    this.seedHistoricCandles(symbol, 60, candles);
  }
}
