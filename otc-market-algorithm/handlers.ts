/**
 * OTC Market Algorithm – HTTP handlers for candles, price, and pending trade registration
 */

import type { Request, Response } from 'express';
import { normalizeOTCSymbol } from './constants.js';
import { GRANULARITY_MAP } from './constants.js';
import { getOTCStore } from './engine.js';
import { addPendingTrade } from './otc-manipulation.js';

function getStore() {
  return getOTCStore();
}

/** GET /api/instruments/:pair/candles – OTC candles. One candle closes every intervalSec seconds (e.g. S5→5s, M1→60s). */
export async function handleCandles(req: Request, res: Response): Promise<void> {
  const { pair } = req.params;
  const symbol = normalizeOTCSymbol(pair);
  if (!symbol) {
    res.status(404).json({ error: 'Not an OTC symbol' });
    return;
  }
  const store = getStore();
  if (!store) {
    res.status(503).json({ error: 'OTC engine not running' });
    return;
  }
  const granularity = String(req.query.granularity || 'M1').toUpperCase();
  const intervalSec = GRANULARITY_MAP[granularity] ?? 60;
  const count = Math.min(Number(req.query.count) || 2000, 5000);
  const from = req.query.from ? new Date(String(req.query.from)).getTime() : undefined;
  const to = req.query.to ? new Date(String(req.query.to)).getTime() : undefined;

  const candles = store.getCandles(symbol, intervalSec, { count, from, to });
  const candlesPayload = candles.map((c) => ({
    time: new Date(c.time).toISOString(),
    mid: { o: String(c.open), h: String(c.high), l: String(c.low), c: String(c.close) },
    complete: true,
  }));

  res.json({
    candles: candlesPayload,
    granularity,
    instrument: symbol,
  });
}

/** GET /api/instruments/:pair/price – OTC latest price. Call only when pair is OTC. */
export async function handlePrice(req: Request, res: Response): Promise<void> {
  const { pair } = req.params;
  const symbol = normalizeOTCSymbol(pair);
  if (!symbol) {
    res.status(404).json({ error: 'Not an OTC symbol' });
    return;
  }
  const store = getStore();
  if (!store) {
    res.status(503).json({ error: 'OTC engine not running' });
    return;
  }
  const tick = store.getPrice(symbol);
  if (!tick) {
    res.status(502).json({ error: 'No price yet' });
    return;
  }
  res.json({ price: tick.price, time: new Date(tick.time).toISOString() });
}

/** POST /api/otc/pending-trade – register a pending OTC trade (main site). Only real-account trades count for manipulation. */
export async function handlePendingTrade(req: Request, res: Response): Promise<void> {
  try {
    const { pair, type, amount, expiryTime, accountType } = (req.body || {}) as {
      pair?: string;
      type?: 'higher' | 'lower';
      amount?: number;
      expiryTime?: number;
      accountType?: 'real' | 'demo';
    };
    const symbol = normalizeOTCSymbol(pair ?? '');
    if (!symbol) {
      res.status(400).json({ error: 'Invalid or non-OTC pair' });
      return;
    }
    if (type !== 'higher' && type !== 'lower') {
      res.status(400).json({ error: 'type must be higher or lower' });
      return;
    }
    const amt = Number(amount);
    const exp = Number(expiryTime);
    if (!Number.isFinite(amt) || amt <= 0 || !Number.isFinite(exp)) {
      res.status(400).json({ error: 'amount and expiryTime required' });
      return;
    }
    const accType = accountType === 'demo' ? 'demo' : 'real';
    addPendingTrade(symbol, type, amt, exp, accType);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
