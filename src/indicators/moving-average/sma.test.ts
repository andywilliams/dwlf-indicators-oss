import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeSMA, detectEvents, getEventDefinitions } from './sma';

describe('computeSMA', () => {
  it('computes a simple moving average of closes by default', () => {
    const result = computeSMA(smallCandles, { length: 3 });

    expect(result.params).toEqual({ length: 3, source: 'close' });
    expect(result.sma).toHaveLength(smallCandles.length - 3 + 1);

    const first = result.sma.at(0);
    const expected = (smallCandles[0].c + smallCandles[1].c + smallCandles[2].c) / 3;

    expect(first?.t).toBe(smallCandles[2].t);
    expect(first?.v).toBeCloseTo(expected, 10);
  });

  it('supports alternative candle sources', () => {
    const result = computeSMA(smallCandles, { length: 4, source: 'high' });

    expect(result.params).toEqual({ length: 4, source: 'high' });

    const first = result.sma.at(0);
    const expected =
      (smallCandles[0].h + smallCandles[1].h + smallCandles[2].h + smallCandles[3].h) / 4;

    expect(first?.v).toBeCloseTo(expected, 10);
  });

  it('resolves default parameters when none are provided', () => {
    const result = computeSMA(smallCandles);

    expect(result.params).toEqual({ length: 14, source: 'close' });
    expect(result.sma.length).toBeGreaterThan(0);
  });

  it('returns an empty series when no candles are provided', () => {
    const result = computeSMA([]);

    expect(result.sma).toHaveLength(0);
  });

  it('validates the period length', () => {
    expect(() => computeSMA(smallCandles, { length: 0 })).toThrowError(/length must be a positive integer/);
  });
});

const buildCandles = (closes: number[]): Candle[] =>
  closes.map((close, index) => ({
    t: index,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
  }));

describe('SMA events', () => {
  it('exposes metadata and emits cross events', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['sma.cross.above', 'sma.cross.below']),
    );

    const candles = buildCandles([10, 10, 10, 9, 8, 12, 13]);
    const events = detectEvents(candles, { length: 3 });

    expect(events.length).toBeGreaterThan(0);
    events.forEach((event) => {
      expect(['sma.cross.above', 'sma.cross.below']).toContain(event.id);
      expect(event.payload?.average).toBeDefined();
    });
  });
});

describe('SMA cross payload (DWLF-331)', () => {
  it('carries the average length, so a stored cross names its period', () => {
    const closes = [10, 10, 10, 10, 10, 9, 8, 12, 13, 14, 9, 8];
    const candles = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));
    const events = detectEvents(candles, { length: 3 });
    expect(new Set(events.map((e) => e.id))).toEqual(new Set(['sma.cross.above', 'sma.cross.below']));
    for (const e of events) {expect(e.payload?.length).toBe(3);}
  });
});
