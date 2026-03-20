/**
 * OTC Market Algorithm – asset list and API symbol normalization
 */

export const OTC_SYMBOLS = [
  // Currencies
  'NZD/USD OTC',
  'USD/ARS OTC',
  'USD/BDT OTC',
  'USD/PHP OTC',
  'NZD/CHF OTC',
  'USD/COP OTC',
  'USD/MXN OTC',
  'NZD/JPY OTC',
  'USD/IDR OTC',
  'GBP/NZD OTC',
  'USD/BRL OTC',
  'AUD/NZD OTC',
  // Special
  'ALTRIX PRO OTC',
  'SH/PRO OTC',
] as const;

export type OTCSymbol = (typeof OTC_SYMBOLS)[number];

/** Normalize pair from API (e.g. "NZD_USD OTC" or "NZD/USD OTC") to our internal symbol */
export function normalizeOTCSymbol(pair: string): string | null {
  const trimmed = String(pair).trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/_/g, '/');
  return OTC_SYMBOLS.includes(normalized as OTCSymbol) ? normalized : null;
}

export function isOTCSymbol(pair: string): boolean {
  return normalizeOTCSymbol(pair) !== null;
}

/** Granularity string to seconds (API/Oanda: S5, S10, S15, S30, M1, M2, …). */
export const GRANULARITY_MAP: Record<string, number> = {
  S5: 5, S10: 10, S15: 15, S30: 30,
  M1: 60, M2: 120, M3: 180, M5: 300, M10: 600, M15: 900, M30: 1800,
  H1: 3600, H4: 14400, D: 86400,
};
