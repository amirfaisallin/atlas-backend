/**
 * OTC Market Algorithm – engine: 1s tick loop, Socket broadcast, multi-timeframe persist
 */

import type { Server as SocketIOServer } from 'socket.io';
import type { OHLC } from './types.js';
import { OTC_SYMBOLS } from './constants.js';
import { OTCStore } from './OTCStore.js';
import { persistOtcCandles, loadHistoricCandlesPerSymbol, loadLastCandlesPerSymbol } from './persistence.js';
import {
  getManipulationOverride,
  removeExpired,
} from './otc-manipulation.js';

const TICK_INTERVAL_MS = 1000;
const PERSIST_BASE_MS = 5_000;
const HISTORIC_CANDLES_LIMIT = 2000;

/** Timeframes persisted to MongoDB so every selectable chart timeframe has full history. */
const PERSIST_INTERVALS_SEC = [
  5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400,
] as const;
/** Timeframes loaded and seeded on startup for complete visual data stream. */
const SEED_INTERVALS_SEC = [
  5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 14400, 86400,
] as const;

let store: OTCStore | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setInterval> | null = null;

export function getOTCStore(): OTCStore | null {
  return store;
}

export function isOTCRunning(): boolean {
  return tickTimer != null;
}

/** Start OTC engine: load last recorded candle per asset for continuity, then historic for chart, then tick loop and persist */
export async function startOTCEngine(io: SocketIOServer | null): Promise<OTCStore> {
  if (store) return store;
  store = new OTCStore();

  // Resume from last recorded point: load last 1m candle per symbol and init generators so new candles continue without gap
  const lastCandles = await loadLastCandlesPerSymbol();
  for (const [symbol, row] of lastCandles) {
    store.setLastCandle(symbol, row.open, row.high, row.low, row.close);
  }
  if (lastCandles.size > 0) {
    console.log(`[OTC] Resumed from last recorded candle for ${lastCandles.size} asset(s)`);
  }

  const historicByInterval = await Promise.all(
    SEED_INTERVALS_SEC.map((intervalSec) =>
      loadHistoricCandlesPerSymbol(HISTORIC_CANDLES_LIMIT, intervalSec)
    )
  );
  for (let i = 0; i < SEED_INTERVALS_SEC.length; i++) {
    const intervalSec = SEED_INTERVALS_SEC[i];
    const historic = historicByInterval[i];
    for (const symbol of OTC_SYMBOLS) {
      const rows = historic.get(symbol);
      if (rows && rows.length > 0) {
        const candles = rows.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        store.seedHistoricCandles(symbol, intervalSec, candles);
      }
    }
  }
  console.log(
    `[OTC] Historic loaded for all timeframes (5s–1d); chart history populated for every selectable timeframe`
  );

  tickTimer = setInterval(() => {
    if (!store) return;
    const now = Date.now();
    removeExpired(now);
    const overrideFn = (
      symbol: string,
      ohlc: OHLC,
      nowMs: number,
      getPeriodOpen?: (intervalSec: number) => number | undefined
    ) => {
      const over = getManipulationOverride(
        symbol,
        ohlc.open,
        ohlc.high,
        ohlc.low,
        ohlc.close,
        nowMs,
        getPeriodOpen
      );
      return over ?? ohlc;
    };
    const results = store.tick(now, overrideFn);
    if (io) {
      for (const { symbol, time, price, ohlc } of results) {
        io.emit('otc_tick', {
          symbol,
          time,
          price,
          ohlc: { o: ohlc.open, h: ohlc.high, l: ohlc.low, c: ohlc.close },
        });
      }
    }
  }, TICK_INTERVAL_MS);

  const lastPersistedByKey = new Map<string, number>();
  function persistKey(symbol: string, intervalSec: number): string {
    return `${symbol}|${intervalSec}`;
  }

  persistTimer = setInterval(async () => {
    if (!store) return;
    const now = Date.now();
    for (const intervalSec of PERSIST_INTERVALS_SEC) {
      const remainderMs = now % (intervalSec * 1000);
      const shouldPersist = intervalSec <= 5 ? true : remainderMs < PERSIST_BASE_MS;
      if (!shouldPersist) continue;
      const items = store.getLastCompletedCandles(intervalSec);
      const toPersist = items.filter(({ symbol, candle }) => {
        const key = persistKey(symbol, intervalSec);
        const last = lastPersistedByKey.get(key) ?? 0;
        if (candle.time <= last) return false;
        lastPersistedByKey.set(key, candle.time);
        return true;
      });
      if (toPersist.length > 0) await persistOtcCandles(toPersist, intervalSec);
    }
  }, PERSIST_BASE_MS);

  console.log('[OTC] Engine started: 1s ticks, multi-timeframe persist (5s–1d)');
  return store;
}

/** Stop OTC engine (e.g. graceful shutdown) */
export function stopOTCEngine(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }
  store = null;
  console.log('[OTC] Engine stopped');
}
