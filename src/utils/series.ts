import type { Candle, LinePoint } from '../types';
import { isFiniteNumber } from './guards';

export type ToLinePointsOptions = {
  offset?: number;
};

export const toLinePoints = (
  candles: Candle[],
  values: Array<number | undefined>,
  options: ToLinePointsOptions = {},
): LinePoint[] => {
  const offset = options.offset ?? 0;
  const points: LinePoint[] = [];

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];

    if (!isFiniteNumber(value)) {
      continue;
    }

    const targetIndex = i + offset;
    if (targetIndex < 0 || targetIndex >= candles.length) {
      continue;
    }

    points.push({ t: candles[targetIndex].t, v: value });
  }

  return points;
};
