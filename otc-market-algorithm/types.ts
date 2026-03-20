/**
 * OTC Market Algorithm – shared types
 */

export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandleTick extends OHLC {
  time: number; // Unix ms
}

export interface PriceTick {
  time: number;
  price: number;
}

/** Granularity in seconds for aggregation */
export type CandleGranularity = 5 | 15 | 60;

/** Market behavior type for generator config */
export type MarketBehavior = 'trending_bullish' | 'trending_bearish' | 'ranging' | 'custom';

export interface AssetConfig {
  symbol: string;
  /** Display name (e.g. "SH/PRO OTC") */
  name: string;
  behavior: MarketBehavior;
  /** Base price or starting level */
  basePrice: number;
  /** For ranging: support level */
  support?: number;
  /** For ranging: resistance level */
  resistance?: number;
  /** Volatility factor (e.g. 0.0002 = small moves) */
  volatility: number;
  /** Optional: trend strength for trending markets (positive = up, negative = down) */
  trendStrength?: number;
  /** Optional: pullback probability 0–1 for trending */
  pullbackProbability?: number;
  /** Optional: custom seed for deterministic behavior */
  seed?: number;
}

export interface GeneratorState {
  lastClose: number;
  lastHigh: number;
  lastLow: number;
  /** For trend: current phase (e.g. wave index) */
  phase?: number;
  /** For ranging: last direction 1 or -1 */
  lastDirection?: number;
  /** Internal accumulator for smooth continuity */
  accumulator?: number;
}
