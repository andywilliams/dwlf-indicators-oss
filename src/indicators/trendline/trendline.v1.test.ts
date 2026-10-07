import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { computeTrendlinesV1, detectEvents, getEventDefinitions } from './trendline.v1';

const buildCandles = (prices: number[]): Candle[] =>
  prices.map((price, index) => ({
    t: index,
    o: price - 2,
    h: price + 2,
    l: price - 4,
    c: price,
  }));

const toTimestamp = (base: Date, days: number): number => {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

const buildMarketData = ({ withBreak = false } = {}): Candle[] => {
  const baseDate = new Date('2024-01-01T00:00:00Z');
  const template = [
    130, 132, 134, 136, 138, 100, 112, 118, 124, 130, 136, 142, 110, 118, 126, 134, 142, 150, 158, 166,
    174, 182, 190,
  ];

  return template.map((closeBase, index) => {
    let close = closeBase;
    let low = close - 1.2;
    let high = close + 1.2;
    let open = close - 0.6;

    if (withBreak && index >= template.length - 3) {
      close = closeBase - 160;
      low = close - 1.6;
      high = close + 1.2;
      open = close - 0.6;
    }

    return {
      t: toTimestamp(baseDate, index),
      o: open,
      h: high,
      l: low,
      c: close,
    };
  });
};


describe('computeTrendlinesV1', () => {
  it('returns empty trendlines when insufficient candles are provided', () => {
    const result = computeTrendlinesV1([]);
    expect(result.trendlines).toHaveLength(0);
  });

  it('detects a rising support line across higher swing lows', () => {
    const candles = buildCandles([110, 100, 120, 105, 125, 110, 130, 115, 140, 130, 150]);
    const { trendlines } = computeTrendlinesV1(candles, { swingLookback: 1 });
    const supportLines = trendlines.filter((line) => line.type === 'support');

    expect(supportLines.length).toBeGreaterThan(0);
    expect(supportLines[0].slope).toBeGreaterThan(0);
    expect(supportLines[0].isActive).toBe(true);
  });

  it('detects multiple resistance lines as swing highs trend lower', () => {
    const candles = buildCandles([200, 220, 210, 215, 205, 210, 195, 205, 190, 200, 185, 195, 180]);
    const { trendlines } = computeTrendlinesV1(candles, { swingLookback: 1 });
    const resistanceLines = trendlines.filter((line) => line.type === 'resistance');

    expect(resistanceLines.length).toBeGreaterThan(0);
    expect(resistanceLines.every((line) => line.slope < 0)).toBe(true);
  });

});

describe('trendline v1 events', () => {
  it('exposes metadata and emits events for each detected line', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'trendline_breach_bullish',
        'trendline_breach_bearish',
        'trendline_break_bullish',
        'trendline_break_bearish',
      ]),
    );
    expect(definitions.some((entry) => entry.id.startsWith('trendline.v1.'))).toBe(false);

    const candles = buildMarketData({ withBreak: true });
    const events = detectEvents(candles, { swingLookback: 2 });
    expect(events.some((event) => event.id === 'trendline_breach_bearish')).toBe(true);
    expect(events.some((event) => event.id.startsWith('trendline.v1.'))).toBe(false);

    const calmEvents = detectEvents(buildMarketData({ withBreak: false }), { swingLookback: 2 });
    expect(calmEvents.some((event) => event.id.startsWith('trendline_breach'))).toBe(false);
  });

  it('emits breach events for active lines when price breaks later', () => {
    const candles = buildMarketData({ withBreak: true });
    const events = detectEvents(candles, { swingLookback: 2 });

    const breakEvent = events.find(
      (event) =>
        event.id === 'trendline_break_bearish' || event.id === 'trendline_break_bullish',
    );

    expect(breakEvent).toBeTruthy();
    if (breakEvent && breakEvent.payload?.detail) {
      expect(breakEvent.payload.detail.index).toBeGreaterThan(breakEvent.payload.startIndex);
    }
  });

  it('stops judging a support line once a lower low is knowable, even one that only wicked through', () => {
    // Lows 95 (bar 1) and 97 (bar 3) draw support at 95 + (k - 1). Bar 6 wicks
    // to 96, below the line but closing above it: a lower low, knowable on bar 7
    // with swingLookback 1. Bar 8 then closes below the line, but the line has
    // ended, so nothing fires there.
    const bars: Array<[number, number, number]> = [
      [100, 103, 104], [95, 98, 100], [100, 104, 106], [97, 100, 102], [101, 105, 107],
      [101, 104, 106], [96, 101, 105], [99, 103, 105], [99.5, 100, 104], [100, 101, 103],
    ];
    const candles = bars.map(([l, c, h], index) => ({ t: index, o: c, h, l, c }));
    const support = detectEvents(candles, { swingLookback: 1 }).filter(
      (event) => event.payload?.lineType === 'support',
    );
    expect(support.map((event) => `${event.id}@${event.index}`)).toEqual(['trendline_breach_bearish@6']);
  });

  it('a line drawn again after a gap stays spent if a close broke it in the gap', () => {
    // Support lows a(1,10) b(6,12) c(11,20) d(16,21) e(21,30), swingLookback 1.
    // The best pair is a-c, then a-d once d is knowable (bar 17), then a-c again
    // once e is (bar 22). Bar 17 closes through a-c while a-d is drawn instead,
    // so when a-c returns it is already spent: bar 24's close through it is no break.
    const lows = [12, 10, 11, 11.5, 12.5, 13, 12, 13, 15, 18, 21, 20, 22, 23, 24, 22.5, 21, 22, 25, 26, 31, 30, 32, 33, 31, 35];
    const closes: Record<number, number> = { 15: 24.5, 16: 26, 17: 25.5, 23: 34, 24: 31.5 };
    const candles = lows.map((l, t) => {
      const c = closes[t] ?? l + 1.5;
      return { t, o: l + 1, l, h: Math.max(l + 3, c + 0.5), c };
    });
    const support = detectEvents(candles, { swingLookback: 1 }).filter(
      (event) => event.payload?.lineType === 'support',
    );
    expect(support.map((event) => `${event.id}@${event.index}`)).toEqual(['trendline_breach_bearish@15']);
  });
});

