import type { Request, Response } from 'express';

const OANDA_BASE = 'https://api-fxpractice.oanda.com';

function getToken(): string | undefined {
  return process.env.OANDA_TOKEN || process.env.VITE_OANDA_TOKEN;
}

export async function handleCandles(req: Request, res: Response): Promise<void> {
  const token = getToken();
  if (!token) {
    res.status(500).json({ error: 'OANDA_TOKEN not configured' });
    return;
  }
  const { pair } = req.params;
  const { granularity = 'M1', count, from, to } = req.query;
  const params = new URLSearchParams();
  if (granularity) params.set('granularity', String(granularity));
  if (count) params.set('count', String(count));
  if (from) params.set('from', String(from));
  if (to) params.set('to', String(to));
  const url = `${OANDA_BASE}/v3/instruments/${encodeURIComponent(pair)}/candles?${params}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json(data);
      return;
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function handlePrice(req: Request, res: Response): Promise<void> {
  const token = getToken();
  if (!token) {
    res.status(500).json({ error: 'OANDA_TOKEN not configured' });
    return;
  }
  const { pair } = req.params;
  const url = `${OANDA_BASE}/v3/instruments/${encodeURIComponent(pair)}/candles?granularity=M1&count=2`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json(data);
      return;
    }
    const candles = data.candles || [];
    const last = candles[candles.length - 1];
    const mid = last?.mid;
    const price = mid ? parseFloat(mid.c) : null;
    if (price == null) {
      res.status(502).json({ error: 'No price' });
      return;
    }
    res.json({ price, time: last?.time });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
