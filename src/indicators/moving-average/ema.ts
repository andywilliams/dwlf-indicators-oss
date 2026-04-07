import type { Candle, IndicatorEvent, LinePoint } from '../../types';
import { ema as computeEmaArray } from '../../math/ema';
import {
  extractSeries,
  resolveMovingAverageParams,
  type MovingAverageParams,
  type ResolvedMovingAverageParams,
} from './common';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';
import { isFiniteNumber } from '../../utils/guards';

export type EmaResult = {
  ema: LinePoint[];
  params: ResolvedMovingAverageParams;
};

const EMA_EVENT_DEFINITIONS = {
  PRICE_CROSS_ABOVE: {
    id: 'ema.cross.above',
    name: 'Price Crossed Above EMA',
    description: 'Source price moved from at/below the EMA to above it.',
  },
  PRICE_CROSS_BELOW: {
    id: 'ema.cross.below',
    name: 'Price Crossed Below EMA',
    description: 'Source price moved from at/above the EMA to below it.',
  },
} as const;

export type EmaCrossEventPayload = {
  price: number;
  average: number;
  source: ResolvedMovingAverageParams['source'];
};

export const computeEMA = (candles: Candle[], params?: MovingAverageParams): EmaResult => {
  const resolved = resolveMovingAverageParams(params);

  if (candles.length === 0) {
    return {
      ema: [],
      params: resolved,
    };
  }

  const series = extractSeries(candles, resolved.source);
  const values = computeEmaArray(series, resolved.length);

  return {
    ema: toLinePoints(candles, values),
    params: resolved,
  };
};

export type { MovingAverageParams, ResolvedMovingAverageParams } from './common';

export const getEventDefinitions = () => Object.values(EMA_EVENT_DEFINITIONS);

export const detectEvents = (
  candles: Candle[],
  params?: MovingAverageParams,
): IndicatorEvent<EmaCrossEventPayload>[] => {
  if (!candles.length) {
    return [];
  }

  const resolved = resolveMovingAverageParams(params);
  const series = extractSeries(candles, resolved.source);
  const values = computeEmaArray(series, resolved.length);
  const events: IndicatorEvent<EmaCrossEventPayload>[] = [];

  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    const prevValue = values[i - 1];
    const price = series[i];
    const prevPrice = series[i - 1];

    if (!isFiniteNumber(value) || !isFiniteNumber(prevValue)) {
      continue;
    }
    if (!isFiniteNumber(price) || !isFiniteNumber(prevPrice)) {
      continue;
    }

    if (prevPrice <= prevValue && price > value) {
      events.push(
        createIndicatorEvent(EMA_EVENT_DEFINITIONS.PRICE_CROSS_ABOVE, {
          candle: candles[i],
          index: i,
          payload: {
            price,
            average: value,
            source: resolved.source,
          },
        }),
      );
    } else if (prevPrice >= prevValue && price < value) {
      events.push(
        createIndicatorEvent(EMA_EVENT_DEFINITIONS.PRICE_CROSS_BELOW, {
          candle: candles[i],
          index: i,
          payload: {
            price,
            average: value,
            source: resolved.source,
          },
        }),
      );
    }
  }

  return events;
};
