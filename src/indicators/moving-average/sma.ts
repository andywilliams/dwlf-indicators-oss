import type { Candle, IndicatorEvent, LinePoint } from '../../types';
import { sma as computeSmaArray } from '../../math/sma';
import {
  extractSeries,
  resolveMovingAverageParams,
  type MovingAverageParams,
  type ResolvedMovingAverageParams,
} from './common';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';
import { isFiniteNumber } from '../../utils/guards';

export type SmaResult = {
  sma: LinePoint[];
  params: ResolvedMovingAverageParams;
};

const SMA_EVENT_DEFINITIONS = {
  PRICE_CROSS_ABOVE: {
    id: 'sma.cross.above',
    name: 'Price Crossed Above SMA',
    description: 'Source price moved from at/below the SMA to above it.',
  },
  PRICE_CROSS_BELOW: {
    id: 'sma.cross.below',
    name: 'Price Crossed Below SMA',
    description: 'Source price moved from at/above the SMA to below it.',
  },
} as const;

export type SmaCrossEventPayload = {
  price: number;
  average: number;
  source: ResolvedMovingAverageParams['source'];
};

export const computeSMA = (candles: Candle[], params?: MovingAverageParams): SmaResult => {
  const resolved = resolveMovingAverageParams(params);

  if (candles.length === 0) {
    return {
      sma: [],
      params: resolved,
    };
  }

  const series = extractSeries(candles, resolved.source);
  const values = computeSmaArray(series, resolved.length);

  return {
    sma: toLinePoints(candles, values),
    params: resolved,
  };
};

export type { MovingAverageParams, ResolvedMovingAverageParams } from './common';

export const getEventDefinitions = () => Object.values(SMA_EVENT_DEFINITIONS);

export const detectEvents = (
  candles: Candle[],
  params?: MovingAverageParams,
): IndicatorEvent<SmaCrossEventPayload>[] => {
  if (!candles.length) {
    return [];
  }

  const resolved = resolveMovingAverageParams(params);
  const series = extractSeries(candles, resolved.source);
  const values = computeSmaArray(series, resolved.length);
  const events: IndicatorEvent<SmaCrossEventPayload>[] = [];

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
        createIndicatorEvent(SMA_EVENT_DEFINITIONS.PRICE_CROSS_ABOVE, {
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
        createIndicatorEvent(SMA_EVENT_DEFINITIONS.PRICE_CROSS_BELOW, {
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
