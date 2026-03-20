/**
 * Admin API handlers for OTC Market Manipulation – stats and toggle.
 */

import type { Request, Response } from 'express';
import { getAllMarketStats, setManipulation, getGlobalManipulation, setGlobalManipulation } from './otc-manipulation.js';

/** GET /api/admin/otc-manipulation – list all OTC markets with stats and global manipulation state */
export async function handleAdminGetOtcManipulation(_req: Request, res: Response): Promise<void> {
  try {
    const now = Date.now();
    const markets = getAllMarketStats(now);
    res.json({ globalManipulation: getGlobalManipulation(), markets });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** PATCH /api/admin/otc-manipulation – set global manipulation (all markets) or per-symbol */
export async function handleAdminPatchOtcManipulation(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    if (typeof body.global === 'boolean') {
      setGlobalManipulation(body.global);
      return res.json({ ok: true, globalManipulation: body.global });
    }
    if (typeof body.symbol === 'string' && typeof body.enabled === 'boolean') {
      setManipulation(body.symbol, body.enabled);
      return res.json({ ok: true, symbol: body.symbol, enabled: body.enabled });
    }
    if (typeof body === 'object' && body !== null && !Array.isArray(body) && body.global === undefined) {
      for (const [symbol, enabled] of Object.entries(body)) {
        if (typeof enabled === 'boolean') setManipulation(symbol, enabled);
      }
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Send { global: boolean } or { symbol, enabled } or { [symbol]: boolean }' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
