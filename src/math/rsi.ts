import type { Candle } from '../types';
import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

const toRsi = (avgGain: number, avgLoss: number): number => {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  return 100 - 100 / (1 + avgGain / avgLoss);
};

/**
 * Wilder's Relative Strength Index on closes, aligned to `candles`: undefined
 * until `period` close-to-close changes exist, whose gains and losses seed the
 * averages with their simple mean; then avg = (avg * (period - 1) + x) / period.
 * A candle without a finite close restarts the seed.
 */
export const rsi = (candles: Candle[], period: number = 14): Array<number | undefined> => {
  assertPositiveInteger(period, 'period');

  const result: Array<number | undefined> = Array.from({ length: candles.length }, () => undefined);
  let previousClose: number | undefined;
  let seedGain = 0;
  let seedLoss = 0;
  let seeded = 0;
  let avgGain: number | undefined;
  let avgLoss: number | undefined;

  for (let i = 0; i < candles.length; i += 1) {
    const close = candles[i].c;
    if (!isFiniteNumber(close)) {
      previousClose = undefined;
      seedGain = 0;
      seedLoss = 0;
      seeded = 0;
      avgGain = undefined;
      avgLoss = undefined;
      continue;
    }
    if (previousClose === undefined) {
      previousClose = close;
      continue;
    }

    const change = close - previousClose;
    previousClose = close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (avgGain === undefined || avgLoss === undefined) {
      seedGain += gain;
      seedLoss += loss;
      seeded += 1;
      if (seeded === period) {
        avgGain = seedGain / period;
        avgLoss = seedLoss / period;
        result[i] = toRsi(avgGain, avgLoss);
      }
      continue;
    }

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = toRsi(avgGain, avgLoss);
  }

  return result;
};
