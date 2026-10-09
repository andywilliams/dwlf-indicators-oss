import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeSMA, detectCrossoverEvents, detectEvents, getEventDefinitions } from './sma';

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

describe('SMA golden and death crosses (DWLF-337)', () => {
  // Falls, then rises, then falls again: the fast average crosses the slow one
  // up once and down once.
  const closes = [
    ...Array.from({ length: 12 }, (_, i) => 100 - i),
    ...Array.from({ length: 12 }, (_, i) => 88 + i * 2),
    ...Array.from({ length: 12 }, (_, i) => 110 - i * 3),
  ];
  const candles = buildCandles(closes);
  const fastValues = computeSMA(candles, { length: 3 }).sma;
  const slowValues = computeSMA(candles, { length: 8 }).sma;

  it('advertises the golden and death crosses', () => {
    expect(getEventDefinitions().map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['sma.cross.golden', 'sma.cross.death']),
    );
  });

  it('fires on the bar the fast average crosses the slow one, in each direction', () => {
    const events = detectCrossoverEvents(candles, { fast: 3, slow: 8 });
    expect(events.map((event) => event.id)).toEqual(['sma.cross.golden', 'sma.cross.death']);

    const valueAt = (series: typeof fastValues, t: number) => series.find((point) => point.t === t)?.v as number;
    for (const event of events) {
      const i = event.index as number;
      const [prevFast, fast] = [valueAt(fastValues, candles[i - 1].t), valueAt(fastValues, candles[i].t)];
      const [prevSlow, slow] = [valueAt(slowValues, candles[i - 1].t), valueAt(slowValues, candles[i].t)];
      if (event.id === 'sma.cross.golden') {
        expect(prevFast).toBeLessThanOrEqual(prevSlow);
        expect(fast).toBeGreaterThan(slow);
      } else {
        expect(prevFast).toBeGreaterThanOrEqual(prevSlow);
        expect(fast).toBeLessThan(slow);
      }
      expect(event.payload).toEqual({ fast, slow, fastLength: 3, slowLength: 8, source: 'close' });
    }
  });

  it('defaults to the 50 over 200 cross', () => {
    const long = buildCandles([
      ...Array.from({ length: 220 }, (_, i) => 300 - i),
      ...Array.from({ length: 120 }, (_, i) => 80 + i * 3),
    ]);
    const [golden] = detectCrossoverEvents(long);
    expect(golden?.id).toBe('sma.cross.golden');
    expect(golden?.payload).toMatchObject({ fastLength: 50, slowLength: 200 });
  });

  it('refuses a fast period that is not shorter than the slow one', () => {
    expect(() => detectCrossoverEvents(candles, { fast: 8, slow: 8 })).toThrow(RangeError);
    expect(() => detectCrossoverEvents(candles, { fast: 0, slow: 8 })).toThrow();
  });

  it('leaves the price-cross events as they were', () => {
    // The close turns up through its 3-bar average at bar 13 and back down at bar 25.
    expect(detectEvents(candles, { length: 3 }).map((event) => [event.id, event.index])).toEqual([
      ['sma.cross.above', 13],
      ['sma.cross.below', 25],
    ]);
  });
});
