import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { evaluateTrendlineBreaches } from './breachDetection';

describe('evaluateTrendlineBreaches', () => {
  it('captures every intraday and closing breach for a single trendline', () => {
    const candles: Candle[] = [
      { t: 0, o: 101, h: 102, l: 100, c: 101 },
      { t: 1, o: 101, h: 102, l: 99.5, c: 101 },
      { t: 2, o: 101, h: 102, l: 99.2, c: 101.1 },
      { t: 3, o: 101, h: 102, l: 100, c: 101.3 },
      { t: 4, o: 101, h: 102, l: 98.5, c: 99 },
    ];

    const line = {
      type: 'support' as const,
      startIndex: 0,
      endIndex: candles.length - 1,
      startPrice: 100,
      slope: 0,
    };

    const evaluation = evaluateTrendlineBreaches(candles, line);

    expect(evaluation.breaches.map((detail) => detail.index)).toEqual([4]);
    expect(evaluation.breachCloses.map((detail) => detail.index)).toEqual([4]);
  });

  it('only evaluates candles that occur after the trendline is anchored', () => {
    const candles: Candle[] = [
      { t: 0, o: 110, h: 111, l: 109, c: 110 },
      { t: 1, o: 111, h: 112, l: 110, c: 111 },
      { t: 2, o: 112, h: 112.5, l: 110.5, c: 111.5 },
      { t: 3, o: 109, h: 109.3, l: 108.8, c: 109.1 },
      { t: 4, o: 109, h: 110.2, l: 107.5, c: 108.6 },
      { t: 5, o: 108, h: 109.2, l: 106.8, c: 108.4 },
    ];

    const line = {
      type: 'resistance' as const,
      startIndex: 0,
      endIndex: 3,
      startPrice: 111,
      slope: -0.5,
    };

    const evaluation = evaluateTrendlineBreaches(candles, line);

    expect(evaluation.breaches.map((detail) => detail.index)).toEqual([4]);
    expect(evaluation.breachCloses.map((detail) => detail.index)).toEqual([]);
    expect(evaluation.breaches.every((detail) => detail.index > line.endIndex)).toBe(true);
  });

  it('records a new intraday breach after price closes back on the safe side', () => {
    const candles: Candle[] = [
      { t: 0, o: 100, h: 101, l: 100, c: 100 },
      { t: 1, o: 101, h: 102, l: 99.5, c: 101.5 },
      { t: 2, o: 102, h: 103, l: 100.2, c: 102 },
      { t: 3, o: 100.5, h: 101.2, l: 98, c: 99 },
    ];

    const line = {
      type: 'support' as const,
      startIndex: 0,
      endIndex: 0,
      startPrice: 100,
      slope: 0,
    };

    const evaluation = evaluateTrendlineBreaches(candles, line);

    expect(evaluation.breaches.map((detail) => detail.index)).toEqual([1, 3]);
    expect(evaluation.breachCloses.map((detail) => detail.index)).toEqual([3]);
  });

  it('flags a bullish close breach when price finishes above a down trendline', () => {
    const candles: Candle[] = [
      { t: 0, o: 210, h: 211, l: 209, c: 210 },
      { t: 1, o: 209.5, h: 209.8, l: 208.6, c: 209 },
      { t: 2, o: 208, h: 208.4, l: 207.5, c: 207.8 },
      { t: 3, o: 206.1, h: 206.4, l: 205.5, c: 205.9 },
      { t: 4, o: 207.2, h: 208.6, l: 206.8, c: 208.2 },
    ];

    const line = {
      type: 'resistance' as const,
      startIndex: 0,
      endIndex: 2,
      startPrice: 211,
      slope: -1.5,
    };

    const evaluation = evaluateTrendlineBreaches(candles, line);

    expect(evaluation.breaches.map((detail) => detail.index)).toEqual([4]);
    expect(evaluation.breachCloses.map((detail) => detail.index)).toEqual([4]);
  });
});
