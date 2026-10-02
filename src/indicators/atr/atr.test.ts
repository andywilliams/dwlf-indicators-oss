import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { atr, trueRange } from '../../math/atr';
import { computeAtr, detectEvents, getEventDefinitions, resolveAtrParams } from './atr';

const candle = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 0 });

// Close fixed at 100 so ATR% = ATR; each candle's span is its true range.
const spanCandles = (spans: number[]): Candle[] =>
  spans.map((span, i) => candle(i * 86_400_000, 100, 100 + span / 2, 100 - span / 2, 100));

describe('trueRange', () => {
  it('uses the high-low span for the first candle and gaps thereafter', () => {
    const candles = [candle(0, 10, 12, 9, 11), candle(1, 14, 15, 13, 14), candle(2, 10, 11, 8, 9)];
    // 12-9=3; max(2, |15-11|=4, |13-11|=2)=4; max(3, |11-14|=3, |8-14|=6)=6
    expect(trueRange(candles)).toEqual([3, 4, 6]);
  });
});

describe('atr (Wilder)', () => {
  it('seeds with the mean of the first `period` true ranges, then smooths by 1/period', () => {
    const candles = spanCandles([2, 4, 6, 8]);
    const values = atr(candles, 3);
    expect(values[0]).toBeUndefined();
    expect(values[1]).toBeUndefined();
    expect(values[2]).toBeCloseTo(4, 10); // (2+4+6)/3
    expect(values[3]).toBeCloseTo((4 * 2 + 8) / 3, 10);
  });

  it('restarts the seed after a candle without a finite range', () => {
    const candles = spanCandles([2, 2, 2, 2]);
    candles[1] = { ...candles[1], h: Number.NaN };
    const values = atr(candles, 2);
    expect(values[1]).toBeUndefined();
    expect(values[2]).toBeUndefined(); // one finite range since the gap
    expect(values[3]).toBeCloseTo(2, 10);
  });

  it('rejects a non-positive period', () => {
    expect(() => atr(spanCandles([1]), 0)).toThrow(TypeError);
  });
});

describe('computeAtr', () => {
  it('returns ATR and ATR% as line points from the first defined bar', () => {
    const candles = spanCandles([2, 4, 6, 8]);
    const result = computeAtr(candles, { length: 3 });
    expect(result.atr).toHaveLength(2);
    expect(result.atr[0]).toEqual({ t: candles[2].t, v: 4 });
    expect(result.atrPercent[0].v).toBeCloseTo(4, 10); // close is 100
    expect(result.params).toEqual({ length: 3, percentileWindow: 100, expansionPercentile: 80, contractionPercentile: 20, episodeResetPercentile: 50 });
  });
});

describe('detectEvents', () => {
  const params = { length: 2, percentileWindow: 10, expansionPercentile: 80, contractionPercentile: 20 };

  it('defines the expansion and contraction events', () => {
    expect(getEventDefinitions().map((d) => d.id)).toEqual(['atr.regime.expansion', 'atr.regime.contraction']);
  });

  it('fires expansion once when volatility jumps, then contraction once when it settles', () => {
    // A flat calm, a burst, then a calm well below the burst.
    const spans = [
      ...Array.from({ length: 15 }, () => 1),
      10, 12, 14, 14, 14,
      ...Array.from({ length: 15 }, () => 0.5),
    ];
    const events = detectEvents(spanCandles(spans), params);
    expect(events.map((e) => e.id)).toEqual(['atr.regime.expansion', 'atr.regime.contraction']);

    const [expansion, contraction] = events;
    expect(expansion.index).toBe(15); // the first burst bar
    expect(expansion.payload?.percentile).toBeGreaterThanOrEqual(80);
    expect(expansion.payload?.threshold).toBe(80);
    expect(contraction.index).toBeGreaterThan(19);
    expect(contraction.payload?.percentile).toBeLessThanOrEqual(20);
  });

  it('does not re-fire while volatility stays expanded', () => {
    const spans = [...Array.from({ length: 12 }, () => 1), ...Array.from({ length: 10 }, (_, i) => 5 + i)];
    const ids = detectEvents(spanCandles(spans), params).map((e) => e.id);
    expect(ids).toEqual(['atr.regime.expansion']);
  });

  it('does not re-fire while the percentile hovers at the threshold', () => {
    // After the burst, small swings keep the percentile around the top band
    // without it returning to the median.
    const spans = [...Array.from({ length: 12 }, () => 1), 5, 4.6, 5.2, 4.7, 5.3, 4.8, 5.4];
    const ids = detectEvents(spanCandles(spans), params).map((e) => e.id);
    expect(ids).toEqual(['atr.regime.expansion']);
  });

  it('can fire again after the episode returns past the median', () => {
    const spans = [
      ...Array.from({ length: 12 }, () => 1),
      8, 8, // expansion
      ...Array.from({ length: 12 }, () => 1), // back to calm: percentile falls below the median
      12, 12, // a second expansion
    ];
    const ids = detectEvents(spanCandles(spans), params).map((e) => e.id).filter((id) => id === 'atr.regime.expansion');
    expect(ids).toEqual(['atr.regime.expansion', 'atr.regime.expansion']);
  });

  it('ranks a flat window at the median, so a calm market is not read as expanded', () => {
    expect(detectEvents(spanCandles(Array.from({ length: 30 }, () => 1)), params)).toEqual([]);
  });

  it('emits nothing until the percentile window is full', () => {
    expect(detectEvents(spanCandles([1, 1, 1, 9, 9]), params)).toEqual([]);
  });

  it('validates thresholds', () => {
    expect(() => resolveAtrParams({ expansionPercentile: 20, contractionPercentile: 20 })).toThrow(TypeError);
    expect(() => resolveAtrParams({ expansionPercentile: 100 })).toThrow(TypeError);
    expect(() => resolveAtrParams({ percentileWindow: 1 })).toThrow(TypeError);
    expect(() => resolveAtrParams({ episodeResetPercentile: 85 })).toThrow(TypeError);
    // A 2-bar window ranks only 25 / 50 / 75: the default thresholds are unreachable.
    expect(() => resolveAtrParams({ percentileWindow: 2 })).toThrow(/thresholds must lie within/);
  });

  it('treats a non-positive close as a gap rather than inverting ATR%', () => {
    const spans = [...Array.from({ length: 12 }, () => 1), 8, 8];
    const candles = spanCandles(spans);
    candles[13] = { ...candles[13], c: -100 };
    const events = detectEvents(candles, params);
    expect(events.map((e) => e.id)).toEqual(['atr.regime.expansion']);
    expect(events[0].index).toBe(12);
  });

  it('keeps detecting through a single bad candle', () => {
    const spans = [...Array.from({ length: 12 }, () => 1), ...Array.from({ length: 4 }, () => 1), 8, 8];
    const candles = spanCandles(spans);
    candles[13] = { ...candles[13], c: Number.NaN };
    const ids = detectEvents(candles, params).map((e) => e.id);
    expect(ids).toEqual(['atr.regime.expansion']);
  });
});
