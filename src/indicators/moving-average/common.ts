import type { Candle } from '../../types';
import { assertPositiveInteger } from '../../utils/guards';

export type MovingAverageSource = 'open' | 'high' | 'low' | 'close';

export type MovingAverageParams = {
  length?: number;
  source?: MovingAverageSource;
};

export type ResolvedMovingAverageParams = Required<MovingAverageParams>;

const DEFAULT_PARAMS: ResolvedMovingAverageParams = {
  length: 14,
  source: 'close',
};

export const resolveMovingAverageParams = (
  params: MovingAverageParams = {},
): ResolvedMovingAverageParams => {
  const resolved: ResolvedMovingAverageParams = {
    length: params.length ?? DEFAULT_PARAMS.length,
    source: params.source ?? DEFAULT_PARAMS.source,
  };

  assertPositiveInteger(resolved.length, 'length');

  return resolved;
};

export const selectSourceValue = (candle: Candle, source: MovingAverageSource): number => {
  switch (source) {
    case 'open':
      return candle.o;
    case 'high':
      return candle.h;
    case 'low':
      return candle.l;
    case 'close':
    default:
      return candle.c;
  }
};

export const extractSeries = (
  candles: Candle[],
  source: MovingAverageSource,
): Array<number | undefined> => candles.map((candle) => selectSourceValue(candle, source));
