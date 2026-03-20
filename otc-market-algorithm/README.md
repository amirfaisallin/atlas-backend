# OTC Market Algorithm

High-performance algorithmic OTC price engine: real-time ticks, 5s/15s/1m candles, MongoDB batch persist, Socket.IO broadcast.

## Folder structure

```
backend/otc-market-algorithm/
├── constants.ts      # OTC symbol list, normalizeOTCSymbol(), isOTCSymbol(), GRANULARITY_MAP
├── types.ts          # OHLC, CandleTick, AssetConfig, GeneratorState, MarketBehavior
├── MarketGenerator.ts # Base + ShProOtcGenerator (primary), TrendingOtcGenerator, RangingOtcGenerator, createGenerator()
├── OTCStore.ts       # In-memory store: per-symbol ticks, 5s/15s/60s aggregation
├── persistence.ts    # Batch save 1m OHLC every 60s; loadLastCandlesPerSymbol() for startup continuity
├── engine.ts         # startOTCEngine(io): 1s tick loop, Socket emit, 60s persist
├── handlers.ts       # handleCandles, handlePrice for /api/instruments/:pair/...
├── index.ts          # Public exports
└── README.md         # This file
```

## Assets

- **Currencies:** NZD/USD, USD/ARS, USD/BDT, USD/PHP, NZD/CHF, USD/COP, USD/MXN, NZD/JPY, USD/IDR, GBP/NZD, USD/BRL, AUD/NZD (all OTC).
- **Special:** ALTRIX PRO OTC (trending bullish), SH/PRO OTC (ranging, primary example).

## Behavior

- **Price logic:** Each asset has its own generator (ranging or trending). Current open = previous close (no gaps).
- **Ticks:** Generated every 1s in-memory; broadcast via `otc_tick` on Socket.IO.
- **Candles:** Aggregated for all timeframes (5s–1d); served via `/api/instruments/:pair/candles?granularity=S5|S10|S15|S30|M1|M2|...|D`.
- **Persistence:** OHLC for all selectable timeframes (5s, 10s, 15s, 30s, 1m, 2m, … 1d) batch-saved to `otc_ohlc` with a `granularity` field (in seconds).
- **Historic loading:** On startup, the engine loads the full historic candlestick sequence from MongoDB **per timeframe** (up to 2000 candles per symbol per interval), seeds the in-memory store for every selectable timeframe, and sets each generator from the last stored 1m candle. When a user switches to any chart timeframe (5s, 10s, 15s, 30s, 1m, 2m, etc.), the API returns the full historical sequence from the seeded store so the visual data stream is consistent and fully populated.

## SH/PRO OTC (primary example)

- **Type:** Ranging between configurable support/resistance.
- **Logic:** Time-based micro-phases (~2 min) with small drift and pullbacks (HH/HL or LH/LL style), mean reversion at edges, hard clamp to range.
- **Config:** `basePrice`, `support`, `resistance`, `volatility`, `seed` for reproducibility.

## API

- `GET /api/instruments/:pair/candles?granularity=S5|S15|M1&count=N` — OTC when `pair` is an OTC symbol.
- `GET /api/instruments/:pair/price` — OTC when `pair` is an OTC symbol.
- **Socket:** `io.emit('otc_tick', { symbol, time, price, ohlc })` every second per symbol.

## MongoDB

- **Collection:** `otc_ohlc`. Documents: `{ symbol, time, open, high, low, close, granularity }` where `granularity` is the interval in seconds (5, 10, 15, 30, 60, 120, … 86400). Index `{ symbol, granularity, time }` used for historic load per timeframe.
