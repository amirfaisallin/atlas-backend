/**
 * OTC Market Algorithm – public API
 */

export { OTC_SYMBOLS, isOTCSymbol, normalizeOTCSymbol, GRANULARITY_MAP } from './constants.js';
export { startOTCEngine, stopOTCEngine, getOTCStore, isOTCRunning } from './engine.js';
export { handleCandles, handlePrice } from './handlers.js';
export { createGenerator, MarketGenerator, ShProOtcGenerator, TrendingOtcGenerator, RangingOtcGenerator } from './MarketGenerator.js';
export type { OHLC, CandleTick, PriceTick, AssetConfig, GeneratorState } from './types.js';
