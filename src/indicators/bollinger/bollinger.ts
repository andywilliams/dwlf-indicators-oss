import type { Candle, BollingerParams, IndicatorEvent, LinePoint } from '../../types';
import { ema as computeEmaArray } from '../../math/ema';
import { sma as computeSmaArray } from '../../math/sma';
import { standardDeviation } from '../../math/stddev';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';
import { extractSeries, selectSourceValue } from '../moving-average/common';

export type ResolvedBollingerParams = Required<BollingerParams>;

const DEFAULT_PARAMS: ResolvedBollingerParams = {
  length: 20,
  basis: 'sma',
  source: 'close',
  standardDeviation: 2,
  offset: 0,
};

const BOLLINGER_EVENT_DEFINITIONS = {
  BREAK_ABOVE_UPPER: {
    id: 'bollinger.break.aboveUpper',
    name: 'Close Broke Above Upper Band',
    description: 'Source price crossed from inside/at the band to above the upper band.',
  },
  BREAK_BELOW_LOWER: {
    id: 'bollinger.break.belowLower',
    name: 'Close Broke Below Lower Band',
    description: 'Source price crossed from inside/at the band to below the lower band.',
  },
} as const;

const isValidBasis = (basis: string): basis is ResolvedBollingerParams['basis'] =>
  basis === 'sma' || basis === 'ema';

export const resolveBollingerParams = (params: BollingerParams = {}): ResolvedBollingerParams => {
  const resolved: ResolvedBollingerParams = {
    length: params.length ?? DEFAULT_PARAMS.length,
    basis: params.basis ?? DEFAULT_PARAMS.basis,
    source: params.source ?? DEFAULT_PARAMS.source,
    standardDeviation: params.standardDeviation ?? DEFAULT_PARAMS.standardDeviation,
    offset: params.offset ?? DEFAULT_PARAMS.offset,
  };

  assertPositiveInteger(resolved.length, 'length');

  if (!isValidBasis(resolved.basis)) {
    throw new TypeError(`basis must be either "sma" or "ema". Received: ${params.basis}`);
  }

  if (!isFiniteNumber(resolved.standardDeviation) || resolved.standardDeviation < 0) {
    throw new TypeError(
      `standardDeviation must be a non-negative finite number. Received: ${params.standardDeviation}`,
    );
  }

  if (!Number.isInteger(resolved.offset)) {
    throw new TypeError(`offset must be an integer. Received: ${params.offset}`);
  }

  return resolved;
};

const computeBasisSeries = (
  series: Array<number | undefined>,
  length: number,
  basis: ResolvedBollingerParams['basis'],
): Array<number | undefined> => {
  if (basis === 'ema') {
    return computeEmaArray(series, length);
  }
  return computeSmaArray(series, length);
};

const computeBandValues = (
  basisValues: Array<number | undefined>,
  deviationValues: Array<number | undefined>,
  multiplier: number,
): Array<number | undefined> =>
  basisValues.map((value, index) => {
    const deviation = deviationValues[index];

    if (!isFiniteNumber(value) || !isFiniteNumber(deviation)) {
      return undefined;
    }

    return value + deviation * multiplier;
  });

export type BollingerBandsResult = {
  upper: LinePoint[];
  middle: LinePoint[];
  lower: LinePoint[];
  params: ResolvedBollingerParams;
};

export type BollingerBandBreakPayload = {
  price: number;
  bandValue: number;
  band: 'upper' | 'lower';
  source: ResolvedBollingerParams['source'];
  offset: number;
};

export const computeBollingerBands = (
  candles: Candle[],
  params?: BollingerParams,
): BollingerBandsResult => {
  const resolved = resolveBollingerParams(params);

  if (candles.length === 0) {
    return {
      upper: [],
      middle: [],
      lower: [],
      params: resolved,
    };
  }

  const series = extractSeries(candles, resolved.source);
  const basisValues = computeBasisSeries(series, resolved.length, resolved.basis);
  const deviationValues = standardDeviation(series, resolved.length);

  const upperValues = computeBandValues(basisValues, deviationValues, resolved.standardDeviation);
  const middleValues = basisValues;
  const lowerValues = computeBandValues(basisValues, deviationValues, -resolved.standardDeviation);

  return {
    upper: toLinePoints(candles, upperValues, { offset: resolved.offset }),
    middle: toLinePoints(candles, middleValues, { offset: resolved.offset }),
    lower: toLinePoints(candles, lowerValues, { offset: resolved.offset }),
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(BOLLINGER_EVENT_DEFINITIONS);

const toTargetIndex =
  (offset: number, length: number) =>
  (index: number): number | null => {
    const target = index + offset;
    if (target < 0 || target >= length) {
      return null;
    }
    return target;
  };

export const detectEvents = (
  candles: Candle[],
  params?: BollingerParams,
): IndicatorEvent<BollingerBandBreakPayload>[] => {
  if (candles.length === 0) {
    return [];
  }

  const resolved = resolveBollingerParams(params);
  const series = extractSeries(candles, resolved.source);
  const basisValues = computeBasisSeries(series, resolved.length, resolved.basis);
  const deviationValues = standardDeviation(series, resolved.length);
  const upperValues = computeBandValues(basisValues, deviationValues, resolved.standardDeviation);
  const lowerValues = computeBandValues(basisValues, deviationValues, -resolved.standardDeviation);
  const resolveTargetIndex = toTargetIndex(resolved.offset, candles.length);

  const events: IndicatorEvent<BollingerBandBreakPayload>[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const targetIndex = resolveTargetIndex(i);
    const prevTargetIndex = resolveTargetIndex(i - 1);
    if (targetIndex === null || prevTargetIndex === null) {
      continue;
    }

    const price = selectSourceValue(candles[targetIndex], resolved.source);
    const prevPrice = selectSourceValue(candles[prevTargetIndex], resolved.source);

    const upper = upperValues[i];
    const prevUpper = upperValues[i - 1];
    if (
      isFiniteNumber(upper) &&
      isFiniteNumber(prevUpper) &&
      isFiniteNumber(price) &&
      isFiniteNumber(prevPrice) &&
      prevPrice <= prevUpper &&
      price > upper
    ) {
      events.push(
        createIndicatorEvent(BOLLINGER_EVENT_DEFINITIONS.BREAK_ABOVE_UPPER, {
          candle: candles[targetIndex],
          index: targetIndex,
          payload: {
            price,
            bandValue: upper,
            band: 'upper',
            source: resolved.source,
            offset: resolved.offset,
          },
        }),
      );
    }

    const lower = lowerValues[i];
    const prevLower = lowerValues[i - 1];
    if (
      isFiniteNumber(lower) &&
      isFiniteNumber(prevLower) &&
      isFiniteNumber(price) &&
      isFiniteNumber(prevPrice) &&
      prevPrice >= prevLower &&
      price < lower
    ) {
      events.push(
        createIndicatorEvent(BOLLINGER_EVENT_DEFINITIONS.BREAK_BELOW_LOWER, {
          candle: candles[targetIndex],
          index: targetIndex,
          payload: {
            price,
            bandValue: lower,
            band: 'lower',
            source: resolved.source,
            offset: resolved.offset,
          },
        }),
      );
    }
  }

  return events;
};
