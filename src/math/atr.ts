import type { Candle } from '../types';
import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

/**
 * True range per candle. The first candle has no previous close, so its true
 * range is its high-low span.
 */
export const trueRange = (candles: Candle[]): Array<number | undefined> =>
  candles.map((candle, i) => {
    const { h, l } = candle;
    if (!isFiniteNumber(h) || !isFiniteNumber(l)) {
      return undefined;
    }
    const prevClose = i > 0 ? candles[i - 1].c : undefined;
    if (!isFiniteNumber(prevClose)) {
      return h - l;
    }
    return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  });

/**
 * Wilder's Average True Range, aligned to `candles`: undefined until `period`
 * true ranges exist, seeded with their simple mean, then
 * atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period.
 * A candle without a finite high/low restarts the seed.
 */
export const atr = (candles: Candle[], period: number = 14): Array<number | undefined> => {
  assertPositiveInteger(period, 'period');

  const ranges = trueRange(candles);
  const result: Array<number | undefined> = Array.from({ length: candles.length }, () => undefined);
  let seedSum = 0;
  let seeded = 0;
  let previous: number | undefined;

  for (let i = 0; i < ranges.length; i += 1) {
    const tr = ranges[i];
    if (!isFiniteNumber(tr)) {
      seedSum = 0;
      seeded = 0;
      previous = undefined;
      continue;
    }
    if (previous === undefined) {
      seedSum += tr;
      seeded += 1;
      if (seeded === period) {
        previous = seedSum / period;
        result[i] = previous;
      }
      continue;
    }
    previous = (previous * (period - 1) + tr) / period;
    result[i] = previous;
  }

  return result;
};
