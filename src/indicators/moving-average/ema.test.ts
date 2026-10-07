import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeEMA, detectEvents, getEventDefinitions } from './ema';

describe('computeEMA', () => {
  it('computes an exponential moving average of closes by default', () => {
    const result = computeEMA(smallCandles, { length: 3 });

    expect(result.params).toEqual({ length: 3, source: 'close' });
    expect(result.ema).toHaveLength(smallCandles.length - 3 + 1);

    const first = result.ema.at(0);
    const expectedFirst = (smallCandles[0].c + smallCandles[1].c + smallCandles[2].c) / 3;

    expect(first?.t).toBe(smallCandles[2].t);
    expect(first?.v).toBeCloseTo(expectedFirst, 10);

    const second = result.ema.at(1);
    const multiplier = 2 / (3 + 1);
    const expectedSecond = (smallCandles[3].c - expectedFirst) * multiplier + expectedFirst;

    expect(second?.v).toBeCloseTo(expectedSecond, 10);
  });

  it('supports alternative candle sources', () => {
    const result = computeEMA(smallCandles, { length: 3, source: 'low' });

    const expected = (smallCandles[0].l + smallCandles[1].l + smallCandles[2].l) / 3;

    expect(result.params).toEqual({ length: 3, source: 'low' });
    expect(result.ema.at(0)?.v).toBeCloseTo(expected, 10);
  });

  it('resolves default parameters when none are provided', () => {
    const result = computeEMA(smallCandles);

    expect(result.params).toEqual({ length: 14, source: 'close' });
    expect(result.ema.length).toBeGreaterThan(0);
  });

  it('returns an empty series when no candles are provided', () => {
    const result = computeEMA([]);

    expect(result.ema).toHaveLength(0);
  });

  it('validates the period length', () => {
    expect(() => computeEMA(smallCandles, { length: 0 })).toThrowError(/length must be a positive integer/);
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

describe('EMA events', () => {
  it('exposes metadata and emits cross events', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'ema.cross.above',
        'ema.cross.below',
      ]),
    );

    const candles = buildCandles([10, 11, 12, 9, 8, 14, 15]);
    const events = detectEvents(candles, { length: 3 });

    expect(events.length).toBeGreaterThan(0);
    const crossEvent = events.find(
      (event) => event.id === 'ema.cross.above' || event.id === 'ema.cross.below',
    );
    expect(crossEvent).toBeDefined();
    if (crossEvent) {
      expect(crossEvent.payload).toBeDefined();
      expect(crossEvent.payload?.average).toBeGreaterThan(0);
    }
  });
});

describe('EMA cross payload (DWLF-331)', () => {
  it('carries the average length, so a stored cross names its period', () => {
    const closes = [10, 10, 10, 10, 10, 9, 8, 12, 13, 14, 9, 8];
    const candles = closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 }));
    const events = detectEvents(candles, { length: 3 });
    expect(new Set(events.map((e) => e.id))).toEqual(new Set(['ema.cross.above', 'ema.cross.below']));
    for (const e of events) {expect(e.payload?.length).toBe(3);}
  });
});
