# @dwlf/indicators

Zero-dependency technical indicators for Node.js, browsers, and workers.

**Pure math — candles in, values out.** No market data, no side effects, no runtime dependencies.

## Install

```bash
npm install @dwlf/indicators
# or
pnpm add @dwlf/indicators
```

## Quick Start

```typescript
import { DSS, Bollinger, EMA, SupportResistance } from '@dwlf/indicators';
import type { Candle } from '@dwlf/indicators';

const candles: Candle[] = [
  { t: 1700000000, o: 100, h: 105, l: 98, c: 103, v: 1000 },
  // ...
];

// Compute indicators
const ema8 = EMA.computeEMA(candles, 8);
const dss = DSS.computeDSS(candles, { length: 10, smooth1: 9, signal: 5 });
const bb = Bollinger.computeBollingerBands(candles, { length: 20, standardDeviation: 2 });

// Detect events
const dssEvents = DSS.detectEvents(candles);
const emaEvents = EMA.detectEvents(candles, 8);
```

## Indicators

| Module | Description |
|--------|-------------|
| `DSS` | Double Smoothed Stochastic (Bressert) |
| `DSSState` | Streaming DSS state tracking |
| `Bollinger` | Bollinger Bands (upper, middle, lower, %B, bandwidth) |
| `EMA` | Exponential Moving Average with event detection |
| `SMA` | Simple Moving Average with event detection |
| `EMACloud` | EMA cloud/ribbon (alignment, cloud hit) |
| `Swing` | Swing high/low detection |
| `SwingBreak` | Swing break detection |
| `SwingSweep` | Liquidity sweep detection |
| `Fib` | Fibonacci retracement levels |
| `SupportResistance` | Support/resistance level calculation |
| `SupportResistanceTracker` | S/R tracking over time |
| `Trendline` | Trendline detection |
| `BreachDetection` | Trendline breach detection |

## Math Utilities

Low-level building blocks, also exported:

```typescript
import { ema, sma, rollingHighest, rollingLowest, standardDeviation } from '@dwlf/indicators';
```

## API Pattern

Every indicator follows the same pattern:

```typescript
// Compute raw values
const result = Module.computeX(candles, params?);

// Detect events (crossovers, threshold breaches, etc.)
const events = Module.detectEvents(candles, params?);

// Get event metadata (what events this indicator can emit)
const definitions = Module.getEventDefinitions();
```

## BYOC: Bring Your Own Candles

This library is intentionally data-source agnostic. Provide candles in the standard OHLCV format:

```typescript
type Candle = {
  t: number;  // timestamp (unix seconds or ms)
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v?: number; // volume (optional)
};
```

## Used By

This is the same indicator math that powers [DWLF](https://dwlf.co.uk) — a market intelligence platform for traders. The event detection, strategy engine, and cycle analysis that sit on top of these indicators are available via the DWLF platform.

## License

MIT
