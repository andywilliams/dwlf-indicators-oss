import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { rsi } from '../../math/rsi';
import { computeRsi, detectEvents, getEventDefinitions, resolveRsiParams } from './rsi';

const closes = (values: number[]): Candle[] =>
  values.map((c, i) => ({ t: i * 86_400_000, o: c, h: c, l: c, c, v: 0 }));

// Wilder's worked example as published by StockCharts (RSI 14). StockCharts rounds the
// averages in its table (70.53, 66.32, 66.55, 69.41, 66.36); unrounded, each is about 0.07 lower.
const STOCKCHARTS = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
  46.03, 46.41, 46.22,
];

describe('rsi (Wilder)', () => {
  it('matches the StockCharts worked example', () => {
    const values = rsi(closes(STOCKCHARTS), 14);
    expect(values.slice(0, 14).every((v) => v === undefined)).toBe(true);
    expect(values[14]).toBeCloseTo(70.464, 3);
    expect(values[15]).toBeCloseTo(66.25, 2);
    expect(values[16]).toBeCloseTo(66.481, 3);
    expect(values[17]).toBeCloseTo(69.347, 3);
    expect(values[18]).toBeCloseTo(66.295, 3);
  });

  it('is 100 with no losses and 50 with no movement', () => {
    expect(rsi(closes([1, 2, 3, 4]), 3)[3]).toBe(100);
    expect(rsi(closes([5, 5, 5, 5]), 3)[3]).toBe(50);
  });

  it('restarts the seed after a candle without a finite close', () => {
    const candles = closes([1, 2, 3, 4, 5, 6]);
    candles[2] = { ...candles[2], c: Number.NaN };
    const values = rsi(candles, 2);
    expect(values[2]).toBeUndefined();
    expect(values[3]).toBeUndefined(); // the first close after the gap has no change yet
    expect(values[4]).toBeUndefined(); // one change since the gap
    expect(values[5]).toBe(100);
  });

  it('rejects a non-positive period', () => {
    expect(() => rsi(closes([1, 2]), 0)).toThrow();
  });
});

describe('RSI module', () => {
  it('publishes four definitions, none under rsi.cross', () => {
    const ids = getEventDefinitions().map((d) => d.id);
    expect(ids).toEqual(['rsi.exit.overbought', 'rsi.exit.oversold', 'rsi.midline.bullish', 'rsi.midline.bearish']);
  });

  it('validates levels', () => {
    expect(resolveRsiParams()).toEqual({ length: 14, overbought: 70, oversold: 30, midline: 50 });
    expect(() => resolveRsiParams({ oversold: 60 })).toThrow();
    expect(() => resolveRsiParams({ overbought: 100 })).toThrow();
  });

  it('computeRsi returns line points from the first value', () => {
    const { rsi: line } = computeRsi(closes(STOCKCHARTS));
    expect(line).toHaveLength(5);
    expect(line[0].t).toBe(14 * 86_400_000);
  });

  it('fires exits and midline crosses on the completing close', () => {
    // length 1: RSI is 100 on an up close, 0 on a down close, 50 when flat.
    const candles = closes([10, 11, 10, 10, 11]);
    const events = detectEvents(candles, { length: 1 });
    const seen = events.map((e) => [e.index, e.id]);
    expect(seen).toEqual([
      [2, 'rsi.exit.overbought'], // 100 -> 0
      [2, 'rsi.midline.bearish'],
      [3, 'rsi.exit.oversold'], // 0 -> 50
      [3, 'rsi.midline.bullish'],
    ]);
    expect(events[0].payload).toEqual({ rsi: 0, previous: 100, level: 70, length: 1 });
  });
});
