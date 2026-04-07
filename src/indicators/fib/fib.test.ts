import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import {
  buildFibLevelSet,
  calculateFibLevels,
  detectEvents,
  detectWeeklyImpulses,
  evaluateBreakout,
  getEventDefinitions,
  normaliseCandles,
} from './fib';

const buildCandles = (prices: number[]): Candle[] =>
  prices.map((price, index) => ({
    t: Date.UTC(2024, 0, 1 + index * 7),
    o: price - 2,
    h: price + 2,
    l: price - 4,
    c: price,
  }));

describe('fib indicator', () => {
  it('normalises candles with timestamps', () => {
    const candles = buildCandles([100, 105]);
    const normalised = normaliseCandles(candles);
    expect(normalised).toHaveLength(2);
    expect(normalised[0]).toMatchObject({
      index: 0,
      open: 98,
      close: 100,
    });
  });

  it('detects impulses when swing criteria are met', () => {
    const candles = buildCandles([100, 110, 120, 115, 130, 128, 140, 135]);
    const impulses = detectWeeklyImpulses(candles, { minMovePct: 5, minDurationWeeks: 1, swingLookback: 1 });
    expect(impulses.length).toBeGreaterThan(0);
    const bullishImpulse = impulses.find((impulse) => impulse.direction === 'bullish');
    expect(bullishImpulse).toBeDefined();
    expect(bullishImpulse?.startPrice).toBeLessThan(bullishImpulse?.endPrice ?? 0);
  });

  it('calculates fib levels for a bullish impulse', () => {
    const impulse = {
      direction: 'bullish' as const,
      startIndex: 0,
      endIndex: 4,
      startDate: '2024-01-01',
      endDate: '2024-02-01',
      startPrice: 100,
      endPrice: 150,
      amplitudePct: 50,
      durationWeeks: 4,
    };
    const levels = calculateFibLevels(impulse, { breakoutExtensionPct: 150 });
    expect(levels).toEqual(expect.arrayContaining([{ label: '50.0%', price: 125 }]));
    expect(levels.some((level) => level.label === '150.0%')).toBe(true);
  });

  it('builds a fib level set with metadata', () => {
    const impulse = {
      direction: 'bullish' as const,
      startIndex: 0,
      endIndex: 2,
      startDate: '2024-01-01',
      endDate: '2024-01-15',
      startPrice: 90,
      endPrice: 120,
      amplitudePct: 33.3,
      durationWeeks: 2,
    };
    const set = buildFibLevelSet('BTC-USD', impulse, { breakoutExtensionPct: 150, swingLookback: 3 });
    expect(set).toMatchObject({
      symbol: 'BTC-USD',
      impulseDirection: 'bullish',
      breakoutExtensionPct: 150,
      swingLookback: 3,
    });
    expect(set?.levels.length).toBeGreaterThan(0);
  });

  it('detects a breakout once price crosses the breakout level', () => {
    const impulse = {
      direction: 'bullish' as const,
      startIndex: 0,
      endIndex: 2,
      startDate: '2024-01-01',
      endDate: '2024-01-15',
      startPrice: 100,
      endPrice: 120,
      amplitudePct: 20,
      durationWeeks: 2,
    };
    const fibSet = buildFibLevelSet('BTC-USD', impulse, { breakoutExtensionPct: 150 });
    expect(fibSet).not.toBeNull();
    const candles = buildCandles([125, 130, 160]);
    const result = evaluateBreakout(fibSet, candles);
    expect(result.breached).toBe(true);
    expect(result.breakoutPrice).toBeCloseTo(fibSet?.levels.find((level) => level.label === '150.0%')?.price ?? 0);
  });

  it('emits events for detected impulses', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(['fib.impulse.detected']);

    const candles = buildCandles([100, 110, 120, 105, 130, 125, 140]);
    const events = detectEvents(candles, { minMovePct: 5, swingLookback: 1 });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].payload?.direction).toMatch(/bullish|bearish/);
  });
});
