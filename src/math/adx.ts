import type { Candle } from '../types';
import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';
import { trueRange } from './atr';

export type DmiSeries = {
  plusDI: Array<number | undefined>;
  minusDI: Array<number | undefined>;
  adx: Array<number | undefined>;
};

/**
 * Wilder's Directional Movement Index, aligned to `candles`.
 * - +DM / -DM per bar from the change in high and low (only the larger, and only when positive).
 * - TR, +DM and -DM are Wilder-summed: the first `period` values summed, then
 *   s = s - s / period + x. +DI / -DI = 100 * sDM / sTR, from bar `period`.
 * - DX = 100 * |+DI - -DI| / (+DI + -DI) (0 when both are 0). ADX seeds with the
 *   mean of the first `period` DX values, then adx = (adx * (period - 1) + dx) / period,
 *   so its first value is at bar 2 * period - 1.
 * TR is `trueRange` from math/atr. A candle without a finite high, low and close
 * restarts everything (as `atr` restarts its seed).
 */
export const dmi = (candles: Candle[], period: number = 14): DmiSeries => {
  assertPositiveInteger(period, 'period');

  const ranges = trueRange(candles);
  const empty = () => Array.from({ length: candles.length }, (): number | undefined => undefined);
  const result: DmiSeries = { plusDI: empty(), minusDI: empty(), adx: empty() };
  let previous: Candle | undefined;
  let count = 0;
  let sumTr = 0;
  let sumPlus = 0;
  let sumMinus = 0;
  let dxSeed: number[] = [];
  let adx: number | undefined;

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    if (!isFiniteNumber(candle.h) || !isFiniteNumber(candle.l) || !isFiniteNumber(candle.c)) {
      previous = undefined;
      count = 0;
      sumTr = 0;
      sumPlus = 0;
      sumMinus = 0;
      dxSeed = [];
      adx = undefined;
      continue;
    }
    if (previous === undefined) {
      previous = candle;
      continue;
    }

    const up = candle.h - previous.h;
    const down = previous.l - candle.l;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    // The library's one true range; `previous` has a finite close, so it is the full three-way range.
    const tr = ranges[i] as number;
    previous = candle;
    count += 1;

    if (count <= period) {
      sumTr += tr;
      sumPlus += plusDm;
      sumMinus += minusDm;
      if (count < period) {
        continue;
      }
    } else {
      sumTr = sumTr - sumTr / period + tr;
      sumPlus = sumPlus - sumPlus / period + plusDm;
      sumMinus = sumMinus - sumMinus / period + minusDm;
    }

    const plusDI = sumTr > 0 ? (100 * sumPlus) / sumTr : 0;
    const minusDI = sumTr > 0 ? (100 * sumMinus) / sumTr : 0;
    result.plusDI[i] = plusDI;
    result.minusDI[i] = minusDI;

    const dx = plusDI + minusDI > 0 ? (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI) : 0;
    if (adx === undefined) {
      dxSeed.push(dx);
      if (dxSeed.length === period) {
        adx = dxSeed.reduce((sum, value) => sum + value, 0) / period;
        result.adx[i] = adx;
      }
      continue;
    }
    adx = (adx * (period - 1) + dx) / period;
    result.adx[i] = adx;
  }

  return result;
};
