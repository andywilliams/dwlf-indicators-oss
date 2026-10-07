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
});
