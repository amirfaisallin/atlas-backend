/**
 * OTC Market Algorithm – MarketGenerator
 * Per-asset price logic with smooth continuity (Current_Open = Previous_Close)
 * and technical patterns (HH/HL, LH/LL).
 */

import type { AssetConfig, GeneratorState, OHLC } from './types.js';

/** Seeded pseudo-random for deterministic, reproducible behavior per asset */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Clamp value between min and max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Base MarketGenerator – generates next tick from previous close.
 * Ensures current open = previous close (no gap).
 */
export abstract class MarketGenerator {
  protected config: AssetConfig;
  protected state: GeneratorState;
  protected random: () => number;

  constructor(config: AssetConfig) {
    this.config = config;
    this.state = {
      lastClose: config.basePrice,
      lastHigh: config.basePrice,
      lastLow: config.basePrice,
    };
    const seed = config.seed ?? 0;
    this.random = seededRandom(seed);
  }

  /** Override in subclasses for asset-specific behavior */
  abstract nextTick(nowMs: number): OHLC;

  /** Get current price (last close) – useful for continuity check */
  getLastClose(): number {
    return this.state.lastClose;
  }

  /** Initialize state from a known candle (e.g. after load from DB) */
  setState(open: number, high: number, low: number, close: number): void {
    this.state.lastClose = close;
    this.state.lastHigh = high;
    this.state.lastLow = low;
  }
}

/**
 * SH/PRO OTC – Primary example.
 * Behavior: Ranging market with clear support/resistance. Price oscillates
 * between levels with HH/HL (higher highs, higher lows) or LH/LL (lower highs, lower lows)
 * in mini-cycles, then reverses. Smooth continuity and predictable structure.
 */
export class ShProOtcGenerator extends MarketGenerator {
  private cyclePhase = 0;
  private subCycle = 0;
  private readonly support: number;
  private readonly resistance: number;
  private readonly range: number;

  constructor(config: AssetConfig) {
    super(config);
    this.support = config.support ?? config.basePrice * 0.98;
    this.resistance = config.resistance ?? config.basePrice * 1.02;
    this.range = this.resistance - this.support;
  }

  nextTick(nowMs: number): OHLC {
    const open = this.state.lastClose; // continuity: current open = previous close
    const vol = this.config.volatility;

    // Time-based phase (e.g. ~2 min micro-trends) for predictability
    const t = Math.floor(nowMs / 120_000) % 4;
    const r = this.random();

    // Within each 2-min window: small drift then small pullback (HH/HL or LH/LL style)
    const sub = Math.floor((nowMs % 120_000) / 30_000);
    let drift: number;
    if (sub === 0) {
      drift = vol * (r > 0.5 ? 1 : -1) * (20 + r * 30);
    } else if (sub === 1) {
      drift = vol * (r > 0.4 ? 1 : -1) * (15 + r * 25);
    } else if (sub === 2) {
      drift = -vol * (r > 0.5 ? 1 : -1) * (10 + r * 20); // pullback
    } else {
      drift = vol * (r - 0.5) * 40; // consolidation
    }

    // Slight bias based on position in range (mean reversion at edges)
    const mid = (this.support + this.resistance) / 2;
    const toMid = mid - open;
    const meanReversion = toMid * 0.02 * (0.5 + this.random() * 0.5);
    let nextClose = open + drift + meanReversion;

    // Hard clamp to support/resistance (ranging)
    nextClose = clamp(nextClose, this.support, this.resistance);

    const high = Math.max(open, nextClose) + vol * this.random() * 5;
    const low = Math.min(open, nextClose) - vol * this.random() * 5;
    const highClamped = Math.min(high, this.resistance);
    const lowClamped = Math.max(low, this.support);

    this.state.lastClose = nextClose;
    this.state.lastHigh = Math.max(open, highClamped, nextClose);
    this.state.lastLow = Math.min(open, lowClamped, nextClose);

    return {
      open,
      high: this.state.lastHigh,
      low: this.state.lastLow,
      close: nextClose,
    };
  }
}

/**
 * Trending market (bullish or bearish) with minor pullbacks.
 */
export class TrendingOtcGenerator extends MarketGenerator {
  private phase = 0;

  nextTick(nowMs: number): OHLC {
    const open = this.state.lastClose;
    const vol = this.config.volatility;
    const strength = this.config.trendStrength ?? 0.0003;
    const pullbackProb = this.config.pullbackProbability ?? 0.25;
    const bullish = (strength ?? 0) >= 0;

    const r = this.random();
    const isPullback = r < pullbackProb;
    let drift = bullish ? strength * 100 : -Math.abs(strength) * 100;
    if (isPullback) drift = -drift * (0.3 + r * 0.7);

    const noise = (this.random() - 0.5) * vol * 80;
    let nextClose = open + drift + noise;

    const high = Math.max(open, nextClose) + vol * this.random() * 15;
    const low = Math.min(open, nextClose) - vol * this.random() * 15;

    this.state.lastClose = nextClose;
    this.state.lastHigh = Math.max(open, high, nextClose);
    this.state.lastLow = Math.min(open, low, nextClose);

    return {
      open,
      high: this.state.lastHigh,
      low: this.state.lastLow,
      close: nextClose,
    };
  }
}

/**
 * Ranging market – strict support/resistance bounce.
 */
export class RangingOtcGenerator extends MarketGenerator {
  private readonly support: number;
  private readonly resistance: number;

  constructor(config: AssetConfig) {
    super(config);
    this.support = config.support ?? config.basePrice * 0.995;
    this.resistance = config.resistance ?? config.basePrice * 1.005;
  }

  nextTick(nowMs: number): OHLC {
    const open = this.state.lastClose;
    const vol = this.config.volatility;
    const r = this.random();
    const toResistance = this.resistance - open;
    const toSupport = open - this.support;
    const bias = toResistance < toSupport ? -1 : 1;
    const move = (r - 0.5) * vol * 100 * bias;
    let nextClose = open + move;
    nextClose = clamp(nextClose, this.support, this.resistance);

    const high = Math.min(Math.max(open, nextClose) + vol * r * 20, this.resistance);
    const low = Math.max(Math.min(open, nextClose) - vol * (1 - r) * 20, this.support);

    this.state.lastClose = nextClose;
    this.state.lastHigh = Math.max(open, high, nextClose);
    this.state.lastLow = Math.min(open, low, nextClose);

    return { open, high: this.state.lastHigh, low: this.state.lastLow, close: nextClose };
  }
}

/** Factory: get generator for symbol */
export function createGenerator(symbol: string, basePrice: number): MarketGenerator {
  const normalized = symbol.replace(/\s+/g, ' ').trim();
  const seed = normalized.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

  switch (normalized) {
    case 'SH/PRO OTC': {
      return new ShProOtcGenerator({
        symbol: normalized,
        name: 'SH/PRO OTC',
        behavior: 'ranging',
        basePrice: basePrice || 1.2550,
        support: (basePrice || 1.2550) * 0.98,
        resistance: (basePrice || 1.2550) * 1.02,
        volatility: 0.00025,
        seed,
      });
    }
    case 'ALTRIX PRO OTC': {
      return new TrendingOtcGenerator({
        symbol: normalized,
        name: 'ALTRIX PRO OTC',
        behavior: 'trending_bullish',
        basePrice: basePrice || 1.1850,
        volatility: 0.0003,
        trendStrength: 0.0004,
        pullbackProbability: 0.2,
        seed,
      });
    }
    case 'NZD/USD OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'NZD/USD OTC',
        behavior: 'ranging',
        basePrice: basePrice || 0.6120,
        support: (basePrice || 0.6120) * 0.998,
        resistance: (basePrice || 0.6120) * 1.002,
        volatility: 0.0002,
        seed,
      });
    case 'USD/ARS OTC':
      return new TrendingOtcGenerator({
        symbol: normalized,
        name: 'USD/ARS OTC',
        behavior: 'trending_bullish',
        basePrice: basePrice || 950,
        volatility: 0.001,
        trendStrength: 0.0005,
        seed,
      });
    case 'USD/BDT OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'USD/BDT OTC',
        behavior: 'ranging',
        basePrice: basePrice || 117.5,
        support: (basePrice || 117.5) * 0.999,
        resistance: (basePrice || 117.5) * 1.001,
        volatility: 0.0001,
        seed,
      });
    case 'USD/PHP OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'USD/PHP OTC',
        behavior: 'ranging',
        basePrice: basePrice || 56.2,
        support: (basePrice || 56.2) * 0.998,
        resistance: (basePrice || 56.2) * 1.002,
        volatility: 0.00015,
        seed,
      });
    case 'NZD/CHF OTC':
      return new TrendingOtcGenerator({
        symbol: normalized,
        name: 'NZD/CHF OTC',
        behavior: 'trending_bearish',
        basePrice: basePrice || 0.5480,
        volatility: 0.00025,
        trendStrength: -0.0003,
        pullbackProbability: 0.25,
        seed,
      });
    case 'USD/COP OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'USD/COP OTC',
        behavior: 'ranging',
        basePrice: basePrice || 3950,
        support: (basePrice || 3950) * 0.997,
        resistance: (basePrice || 3950) * 1.003,
        volatility: 0.0002,
        seed,
      });
    case 'USD/MXN OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'USD/MXN OTC',
        behavior: 'ranging',
        basePrice: basePrice || 17.05,
        support: (basePrice || 17.05) * 0.998,
        resistance: (basePrice || 17.05) * 1.002,
        volatility: 0.0002,
        seed,
      });
    case 'NZD/JPY OTC':
      return new TrendingOtcGenerator({
        symbol: normalized,
        name: 'NZD/JPY OTC',
        behavior: 'trending_bullish',
        basePrice: basePrice || 91.5,
        volatility: 0.0003,
        trendStrength: 0.00025,
        seed,
      });
    case 'USD/IDR OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'USD/IDR OTC',
        behavior: 'ranging',
        basePrice: basePrice || 15750,
        support: (basePrice || 15750) * 0.999,
        resistance: (basePrice || 15750) * 1.001,
        volatility: 0.0001,
        seed,
      });
    case 'GBP/NZD OTC':
      return new TrendingOtcGenerator({
        symbol: normalized,
        name: 'GBP/NZD OTC',
        behavior: 'trending_bearish',
        basePrice: basePrice || 2.08,
        volatility: 0.00035,
        trendStrength: -0.0002,
        seed,
      });
    case 'USD/BRL OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'USD/BRL OTC',
        behavior: 'ranging',
        basePrice: basePrice || 5.42,
        support: (basePrice || 5.42) * 0.998,
        resistance: (basePrice || 5.42) * 1.002,
        volatility: 0.00025,
        seed,
      });
    case 'AUD/NZD OTC':
      return new RangingOtcGenerator({
        symbol: normalized,
        name: 'AUD/NZD OTC',
        behavior: 'ranging',
        basePrice: basePrice || 1.0820,
        support: (basePrice || 1.0820) * 0.998,
        resistance: (basePrice || 1.0820) * 1.002,
        volatility: 0.0002,
        seed,
      });
    default:
      return new RangingOtcGenerator({
        symbol: normalized,
        name: normalized,
        behavior: 'ranging',
        basePrice: basePrice || 1,
        support: (basePrice || 1) * 0.99,
        resistance: (basePrice || 1) * 1.01,
        volatility: 0.0002,
        seed,
      });
  }
}
