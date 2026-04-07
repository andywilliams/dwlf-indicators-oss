import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeEmaCloud, detectEvents, getEventDefinitions, resolveEmaCloudParams } from './emaCloud';

const buildBullishTrendWithPullback = (): Candle[] => {
  const candles: Candle[] = [];
  for (let i = 0; i < 220; i += 1) {
    const price = 100 + i * 0.5;
    candles.push({
      t: i,
      o: price - 0.5,
      h: price + 0.5,
      l: price - 0.7,
      c: price,
    });
  }
  candles.push({
    t: 220,
    o: 210,
    h: 212,
    l: 190,
    c: 195,
  });
  candles.push({
    t: 221,
    o: 195,
    h: 197,
    l: 180,
    c: 185,
  });
  return candles;
};

const buildBearishTrendWithRally = (): Candle[] => {
  const candles: Candle[] = [];
  for (let i = 0; i < 220; i += 1) {
    const price = 200 - i * 0.5;
    candles.push({
      t: i,
      o: price + 0.5,
      h: price + 0.7,
      l: price - 0.5,
      c: price,
    });
  }
  candles.push({
    t: 220,
    o: 90,
    h: 92,
    l: 88,
    c: 91,
  });
  candles.push({
    t: 221,
    o: 91,
    h: 115,
    l: 90,
    c: 110,
  });
  candles.push({
    t: 222,
    o: 110,
    h: 125,
    l: 105,
    c: 120,
  });
  return candles;
};

describe('resolveEmaCloudParams', () => {
  it('applies defaults and normalizes lengths', () => {
    const params = resolveEmaCloudParams({ lengths: [20, 10, 20], source: 'low' });
    expect(params.lengths).toEqual([10, 20]);
    expect(params.source).toBe('low');
  });

  it('requires at least two lengths', () => {
    expect(() => resolveEmaCloudParams({ lengths: [10] })).toThrowError(/two entries/);
  });
});

describe('computeEmaCloud', () => {
  it('computes EMA lines for each configured length', () => {
    const result = computeEmaCloud(smallCandles, { lengths: [3, 5] });

    expect(result.params.lengths).toEqual([3, 5]);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].length).toBe(3);
    expect(result.lines[1].length).toBe(5);
    expect(result.lines[0].points.length).toBeGreaterThan(0);
  });

  it('returns an empty set when no candles are provided', () => {
    const result = computeEmaCloud([]);
    expect(result.lines).toHaveLength(0);
  });
});

describe('EMA cloud events', () => {
  it('exposes metadata for alignment and cloud hits', () => {
    const ids = getEventDefinitions().map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'ema_bullish_alignment',
        'ema_bullish_unalignment',
        'ema_bearish_alignment',
        'ema_bearish_unalignment',
        'ema_bullish_cloud_hit',
        'ema_bearish_cloud_hit',
        'ema_bullish_alignment_sustained',
        'ema_bearish_alignment_sustained',
      ]),
    );
  });

  it('emits bullish alignment, cloud hit, and unalignment events', () => {
    const candles = buildBullishTrendWithPullback();
    const events = detectEvents(candles);
    const ids = events.map((event) => event.id);

    expect(ids).toContain('ema_bullish_alignment');
    expect(ids).toContain('ema_bullish_cloud_hit');
    expect(ids).toContain('ema_bullish_unalignment');
  });

  it('emits bearish alignment, cloud hit, and unalignment events', () => {
    const candles = buildBearishTrendWithRally();
    const events = detectEvents(candles);
    const ids = events.map((event) => event.id);

    expect(ids).toContain('ema_bearish_alignment');
    expect(ids).toContain('ema_bearish_cloud_hit');
    expect(ids).toContain('ema_bearish_unalignment');
  });

  it('emits sustained alignment events after configured duration', () => {
    const bullishCandles = buildBullishTrendWithPullback();
    const bullishEvents = detectEvents(bullishCandles, {
      lengths: [5, 8, 13, 21],
      alignmentConfirmation: 5,
    });
    expect(bullishEvents.map((event) => event.id)).toContain('ema_bullish_alignment_sustained');

    const bearishCandles = buildBearishTrendWithRally();
    const bearishEvents = detectEvents(bearishCandles, {
      lengths: [5, 8, 13, 21],
      alignmentConfirmation: 5,
    });
    expect(bearishEvents.map((event) => event.id)).toContain('ema_bearish_alignment_sustained');
  });
});
