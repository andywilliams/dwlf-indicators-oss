import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeBollingerBands, detectEvents, getEventDefinitions } from './bollinger';

describe('computeBollingerBands', () => {
  it('computes Bollinger Bands with an SMA basis by default', () => {
    const result = computeBollingerBands(smallCandles, { length: 3, standardDeviation: 2 });

    expect(result.params).toEqual({
      length: 3,
      basis: 'sma',
      source: 'close',
      standardDeviation: 2,
      offset: 0,
    });

    expect(result.middle).toHaveLength(smallCandles.length - 3 + 1);
    expect(result.upper).toHaveLength(result.middle.length);
    expect(result.lower).toHaveLength(result.middle.length);

    const firstMiddle = result.middle.at(0);
    const firstUpper = result.upper.at(0);
    const firstLower = result.lower.at(0);

    expect(firstMiddle?.t).toBe(smallCandles[2].t);
    expect(firstMiddle?.v).toBeCloseTo(102, 10);
    expect(firstUpper?.v).toBeCloseTo(103.6329931619, 10);
    expect(firstLower?.v).toBeCloseTo(100.3670068381, 10);
  });

  it('supports EMA basis, alternative sources, and offsetting', () => {
    const result = computeBollingerBands(smallCandles, {
      length: 4,
      basis: 'ema',
      source: 'high',
      standardDeviation: 1.5,
      offset: 1,
    });

    expect(result.params).toEqual({
      length: 4,
      basis: 'ema',
      source: 'high',
      standardDeviation: 1.5,
      offset: 1,
    });

    const first = result.middle.at(0);

    expect(first?.t).toBe(smallCandles[4].t);
    expect(first?.v).toBeGreaterThan(0);
    expect(result.upper.at(0)?.v).toBeGreaterThan(result.middle.at(0)?.v ?? 0);
    expect(result.lower.at(0)?.v).toBeLessThan(result.middle.at(0)?.v ?? 0);
  });

  it('returns empty series when no candles are provided', () => {
    const result = computeBollingerBands([]);

    expect(result.upper).toHaveLength(0);
    expect(result.middle).toHaveLength(0);
    expect(result.lower).toHaveLength(0);
  });

  it('validates parameters', () => {
    expect(() => computeBollingerBands(smallCandles, { length: 0 })).toThrow(/length must be a positive integer/);
    expect(() => computeBollingerBands(smallCandles, { basis: 'wma' as 'sma' })).toThrow(/basis must be either "sma" or "ema"/);
    expect(() => computeBollingerBands(smallCandles, { standardDeviation: -1 })).toThrow(/standardDeviation must be a non-negative finite number/);
    expect(() => computeBollingerBands(smallCandles, { offset: 1.2 })).toThrow(/offset must be an integer/);
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

describe('Bollinger events', () => {
  it('reports metadata and detects band breaks', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['bollinger.break.aboveUpper', 'bollinger.break.belowLower']),
    );

    const candles = buildCandles([100, 100, 100, 140, 150, 120, 80, 70, 60]);
    const events = detectEvents(candles, { length: 3, standardDeviation: 1 });

    expect(events.some((event) => event.id === 'bollinger.break.aboveUpper')).toBe(true);
    expect(events.some((event) => event.id === 'bollinger.break.belowLower')).toBe(true);
  });
});
