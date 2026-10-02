import { describe, expect, it } from 'vitest';

import { smallCandles } from '../../test/fixtures/candles.small';
import type { Candle } from '../types';
import { atr } from './atr';

// The Wilder ATR Trendline carried privately before it moved to math/atr,
// kept verbatim as the reference so a change to the shared ATR cannot shift
// Trendline's ATR-mode breaches unnoticed.
const previousTrendlineAtr = (candles: Candle[], period: number): Array<number | undefined> => {
  const out = new Array<number | undefined>(candles.length).fill(undefined);
  const trueRanges: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const current = candles[i];
    const prevClose = i > 0 ? candles[i - 1].c : current.c;
    const tr = Math.max(current.h - current.l, Math.abs(current.h - prevClose), Math.abs(current.l - prevClose));
    trueRanges.push(tr);
    if (i + 1 < period) {
      continue;
    }
    if (i + 1 === period) {
      out[i] = trueRanges.reduce((acc, value) => acc + value, 0) / period;
      continue;
    }
    const previous = out[i - 1];
    out[i] = previous !== undefined ? (previous * (period - 1) + tr) / period : tr;
  }
  return out;
};

describe('atr matches the ATR Trendline used before sharing it', () => {
  it.each([2, 3, 5])('period %i', (period) => {
    const expected = previousTrendlineAtr(smallCandles, period);
    const actual = atr(smallCandles, period);
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, i) => {
      const reference = expected[i];
      if (reference === undefined) {
        expect(value).toBeUndefined();
      } else {
        expect(value).toBeCloseTo(reference, 10);
      }
    });
  });
});
