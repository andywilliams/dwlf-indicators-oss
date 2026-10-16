import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import {
  computeSMA,
  detectCrossoverEvents,
  detectEvents,
  detectReclaimEvents,
  getEventDefinitions,
} from './sma';

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

describe('SMA reclaim and loss (DWLF-448)', () => {
  const flat = (c: number) => ({ o: c, h: c, l: c, c, v: 1 });
  // A 20-bar average at 100. Price drops below (the starting side, no event),
  // pokes above for one close and falls back, then closes above twice (reclaimed
  // at bar 38), then below twice (lost at bar 40).
  const closes = [
    ...Array.from({ length: 30 }, () => 100),
    ...Array.from({ length: 5 }, () => 90),
    110, 90, 110, 110, 80, 80,
  ];
  const candles: Candle[] = closes.map((c, t) => ({ t, ...flat(c) }));
  const unbuffered = { length: 20, atrMultiple: 0 };

  it('advertises sma.reclaimed and sma.lost', () => {
    expect(getEventDefinitions().map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['sma.reclaimed', 'sma.lost']),
    );
  });

  it('fires on the confirming close, not on a one-bar poke, and alternates', () => {
    expect(detectReclaimEvents(candles, unbuffered).map((event) => [event.id, event.index])).toEqual([
      ['sma.reclaimed', 38],
      ['sma.lost', 40],
    ]);
    // The raw cross fires on the poke and its reversal as well.
    expect(detectEvents(candles, { length: 20 }).filter((event) => (event.index as number) >= 35)).toHaveLength(4);
  });

  it('carries the average, ATR and how long the previous side held', () => {
    const [reclaimed, lost] = detectReclaimEvents(candles, unbuffered);
    const average = computeSMA(candles, { length: 20 }).sma.find((point) => point.t === 38)?.v;
    expect(reclaimed.payload).toMatchObject({
      price: 110,
      average,
      length: 20,
      source: 'close',
      confirmBars: 2,
      atrMultiple: 0,
      atrLength: 14,
      barsOnPreviousSide: 7,
    });
    expect(reclaimed.payload?.distanceAtr).toBeCloseTo((110 - (average as number)) / (reclaimed.payload?.atr as number), 10);
    expect(reclaimed.payload?.direction).toBe('bullish');
    expect(lost.payload).toMatchObject({ direction: 'bearish', price: 80, barsOnPreviousSide: 2 });
    expect(lost.payload?.distanceAtr).toBeLessThan(0);
  });

  it('needs every confirming close to clear the ATR buffer', () => {
    // Closes of 99 sit 1.6 above the average; with 6-point bars, half an ATR is 3.
    const shallow: Candle[] = [
      ...Array.from({ length: 30 }, () => 100),
      ...Array.from({ length: 5 }, () => 90),
      99, 99, 99,
    ].map((c, t) => ({ t, o: c, h: c + 3, l: c - 3, c, v: 1 }));
    expect(detectReclaimEvents(shallow, { length: 20 })).toEqual([]);
    expect(detectReclaimEvents(shallow, unbuffered).map((event) => event.index)).toEqual([36]);
  });

  it('honours confirmBars', () => {
    expect(detectReclaimEvents(candles, { ...unbuffered, confirmBars: 1 }).map((event) => [event.id, event.index])).toEqual([
      ['sma.reclaimed', 35],
      ['sma.lost', 36],
      ['sma.reclaimed', 37],
      ['sma.lost', 39],
    ]);
  });

  it('uses no later bar: a run on every prefix reproduces the full-run events up to it', () => {
    const wave: Candle[] = Array.from({ length: 160 }, (_, t) => {
      const c = 100 + 12 * Math.sin(t / 9) + 4 * Math.sin(t * 1.7);
      return { t, o: c, h: c + 1.5, l: c - 1.5, c, v: 1 };
    });
    const params = { length: 20 };
    const full = detectReclaimEvents(wave, params);
    expect(full.length).toBeGreaterThan(2);
    for (let k = 0; k < wave.length; k += 1) {
      const prefix = detectReclaimEvents(wave.slice(0, k + 1), params);
      expect(prefix).toEqual(full.filter((event) => (event.index as number) <= k));
    }
  });

  it('settles on the first confirmed run, so a later start agrees from its first event on', () => {
    const wave: Candle[] = Array.from({ length: 200 }, (_, t) => {
      const c = 100 + 12 * Math.sin(t / 9) + 4 * Math.sin(t * 1.7);
      return { t, o: c, h: c + 1.5, l: c - 1.5, c, v: 1 };
    });
    // With no buffer the ATR's own start-up cannot move a decision.
    const params = { length: 20, atrMultiple: 0 };
    const key = (event: { id: string; t?: number }) => `${event.id}@${event.t}`;
    const full = detectReclaimEvents(wave, params).map(key);
    for (let start = 1; start < 60; start += 1) {
      const later = detectReclaimEvents(wave.slice(start), params);
      expect(later.length).toBeGreaterThan(0);
      const from = later[0].t as number;
      expect(later.map(key)).toEqual(
        detectReclaimEvents(wave, params).filter((event) => (event.t as number) >= from).map(key),
      );
    }
    expect(full.length).toBeGreaterThan(2);
  });

  it('defaults to the 200-day, two closes, half an ATR', () => {
    expect(detectReclaimEvents([], {})).toEqual([]);
    const long: Candle[] = [
      ...Array.from({ length: 220 }, (_, i) => 300 - i),
      ...Array.from({ length: 120 }, (_, i) => 80 + i * 3),
    ].map((c, t) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1 }));
    const [reclaimed] = detectReclaimEvents(long);
    expect(reclaimed?.id).toBe('sma.reclaimed');
    expect(reclaimed?.payload).toMatchObject({ length: 200, confirmBars: 2, atrMultiple: 0.5, atrLength: 14 });
    expect(reclaimed?.payload?.distanceAtr).toBeGreaterThanOrEqual(0.5);
  });

  it('refuses bad parameters', () => {
    expect(() => detectReclaimEvents(candles, { confirmBars: 0 })).toThrow();
    expect(() => detectReclaimEvents(candles, { atrMultiple: -1 })).toThrow(RangeError);
    expect(() => detectReclaimEvents(candles, { length: 1.5 })).toThrow();
  });
});
