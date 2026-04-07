import { describe, expect, it } from 'vitest';

import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeSwings, detectEvents, getEventDefinitions } from './swing';

const buildCandle = (t: number, high: number, low: number) => ({
  t,
  o: low,
  h: high,
  l: low,
  c: (high + low) / 2,
});

describe('computeSwings', () => {
  it('identifies swing highs and lows using the configured lookback', () => {
    const candles = [
      buildCandle(0, 1, 0),
      buildCandle(1, 5, 1),
      buildCandle(2, 2, -2),
      buildCandle(3, 3, 0),
      buildCandle(4, 4, 1),
    ];

    const result = computeSwings(candles, { lookback: 1 });

    expect(result.highs).toHaveLength(1);
    expect(result.lows).toHaveLength(1);

    const [high] = result.highs;
    const [low] = result.lows;

    expect(high).toMatchObject({ index: 1, price: 5, type: 'high', t: 1 });
    expect(high.candle).toBe(candles[1]);

    expect(low).toMatchObject({ index: 2, price: -2, type: 'low', t: 2 });
    expect(low.candle).toBe(candles[2]);

    expect(result.points.map((p) => p.type)).toEqual(['high', 'low']);
  });

  it('returns no swings when insufficient neighbours are available', () => {
    const result = computeSwings(smallCandles.slice(0, 4), { lookback: 3 });
    expect(result.highs).toHaveLength(0);
    expect(result.lows).toHaveLength(0);
  });

  it('defaults to lookback of 3 and ignores non-finite prices', () => {
    const dirtyCandles = smallCandles.slice(0, 10).map((candle, index) =>
      index === 4 ? { ...candle, h: Number.NaN, l: Number.NaN } : candle,
    );

    const result = computeSwings(dirtyCandles);

    expect(result.highs.length + result.lows.length).toBe(0);
    result.points.forEach((point) => {
      const expectedPrice = point.type === 'high' ? point.candle.h : point.candle.l;
      expect(Number.isFinite(expectedPrice)).toBe(true);
      expect(point.price).toBeCloseTo(expectedPrice, 10);
    });
  });

  it('throws when the lookback parameter is invalid', () => {
    expect(() => computeSwings(smallCandles, { lookback: 0 })).toThrowError(
      /lookback must be a positive integer/i,
    );
  });
});

describe('swing events', () => {
  const swingPatternCandles = [
    buildCandle(0, 5, 1),
    buildCandle(1, 9, 2),
    buildCandle(2, 4, 0),
    buildCandle(3, 10, 3),
    buildCandle(4, 3, -1),
    buildCandle(5, 11, 4),
    buildCandle(6, 6, 2),
    buildCandle(7, 13, 5),
    buildCandle(8, 5, 1),
    buildCandle(9, 7, -2),
  ];

  it('exposes swing high/low metadata', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'swing_high_formed',
        'swing_low_formed',
        'higher_high',
        'higher_low',
        'swing_high_break',
        'swing_low_break',
        'swing_high_sweep',
        'swing_low_sweep',
      ]),
    );
  });

  it('emits events for detected swing points', () => {
    const events = detectEvents(swingPatternCandles, { lookback: 1 });
    expect(events.some((event) => event.id === 'swing_high_formed')).toBe(true);
    expect(events.some((event) => event.id === 'swing_low_formed')).toBe(true);
    expect(events.some((event) => event.id === 'higher_high')).toBe(true);
    expect(events.some((event) => event.id === 'higher_low')).toBe(true);
    expect(events.some((event) => event.id === 'swing_high_break')).toBe(true);
    expect(events.some((event) => event.id === 'swing_low_break')).toBe(true);
  });

  it('emits a swing low sweep when price wicks below and reclaims within the sweep window', () => {
    const candles = [
      buildCandle(0, 10, 6),
      buildCandle(1, 9, 5),
      buildCandle(2, 8, 4), // swing low
      buildCandle(3, 9, 5),
      buildCandle(4, 11, 3), // sweep + reclaim above 4 on same candle
      buildCandle(5, 10, 6),
    ];

    const events = detectEvents(candles, { lookback: 1, sweepBars: 1 });
    expect(events.some((event) => event.id === 'swing_low_sweep')).toBe(true);
  });

  it('emits a swing high sweep when the reclaim happens within the configured bars', () => {
    const candles = [
      buildCandle(0, 8, 4),
      buildCandle(1, 9, 5),
      buildCandle(2, 12, 6), // swing high
      buildCandle(3, 10, 5),
      buildCandle(4, 13, 7), // sweep above 12, close above swing
      buildCandle(5, 14, 9), // reclaim below 12 within 2 bars
      buildCandle(6, 10, 6),
    ];

    const events = detectEvents(candles, { lookback: 1, sweepBars: 2 });
    expect(events.some((event) => event.id === 'swing_high_sweep')).toBe(true);
  });

  it('emits a swing high break when the previous candle matches the swing price', () => {
    const candles = [
      buildCandle(0, 6, 2),
      buildCandle(1, 9, 3),
      buildCandle(2, 10, 4), // swing high
      buildCandle(3, 10, 5), // equal high before break
      buildCandle(4, 11, 6), // break above swing high
      buildCandle(5, 9, 4),
    ];

    const events = detectEvents(candles, { lookback: 1 });
    const breakEvent = events.find((event) => event.id === 'swing_high_break');

    expect(breakEvent).toBeTruthy();
    expect(breakEvent?.index).toBe(4);
    expect(breakEvent?.payload).toMatchObject({
      variant: 'swing_high_break',
      swingType: 'high',
      swingPrice: 10,
      breakPrice: 11,
      previousPrice: 10,
    });
  });

  it('emits a swing low break when the previous candle matches the swing price', () => {
    const candles = [
      buildCandle(0, 12, 6),
      buildCandle(1, 10, 4),
      buildCandle(2, 9, 3), // swing low
      buildCandle(3, 11, 3), // equal low before break
      buildCandle(4, 12, 2), // break below swing low
      buildCandle(5, 10, 5),
    ];

    const events = detectEvents(candles, { lookback: 1 });
    const breakEvent = events.find((event) => event.id === 'swing_low_break');

    expect(breakEvent).toBeTruthy();
    expect(breakEvent?.index).toBe(4);
    expect(breakEvent?.payload).toMatchObject({
      variant: 'swing_low_break',
      swingType: 'low',
      swingPrice: 3,
      breakPrice: 2,
      previousPrice: 3,
    });
  });
});
