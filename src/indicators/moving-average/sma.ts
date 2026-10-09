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
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';

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
  GOLDEN_CROSS: {
    id: 'sma.cross.golden',
    name: 'Golden Cross',
    description: 'The fast SMA (default 50) moved from at/below the slow SMA (default 200) to above it.',
  },
  DEATH_CROSS: {
    id: 'sma.cross.death',
    name: 'Death Cross',
    description: 'The fast SMA (default 50) moved from at/above the slow SMA (default 200) to below it.',
  },
} as const;

export type SmaCrossEventPayload = {
  price: number;
  average: number;
  source: ResolvedMovingAverageParams['source'];
  // The average's period, so a stored cross says which average it crossed
  // without parsing a key (DWLF-331).
  length: number;
};

export type SmaCrossoverParams = {
  /** Period of the fast average. Default 50. */
  fast?: number;
  /** Period of the slow average. Default 200. */
  slow?: number;
  source?: MovingAverageParams['source'];
};

export type SmaCrossoverEventPayload = {
  fast: number;
  slow: number;
  fastLength: number;
  slowLength: number;
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

/**
 * Every SMA event id. `detectEvents` emits the price crosses
 * (`sma.cross.above` / `.below`); `detectCrossoverEvents` emits the golden and
 * death crosses (`sma.cross.golden` / `.death`), whose payload names both
 * averages instead of one.
 */
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
            length: resolved.length,
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
            length: resolved.length,
          },
        }),
      );
    }
  }

  return events;
};

/**
 * Golden and death crosses: the fast SMA crossing the slow one (50 over 200 by
 * default). `detectEvents` covers price crossing one average; this covers one
 * average crossing another, so it takes both periods.
 */
export const detectCrossoverEvents = (
  candles: Candle[],
  params: SmaCrossoverParams = {},
): IndicatorEvent<SmaCrossoverEventPayload>[] => {
  const fastLength = params.fast ?? 50;
  const slowLength = params.slow ?? 200;
  const source = params.source ?? 'close';
  assertPositiveInteger(fastLength, 'fast');
  assertPositiveInteger(slowLength, 'slow');
  if (fastLength >= slowLength) {
    throw new RangeError(`fast must be shorter than slow. Received: fast=${fastLength}, slow=${slowLength}`);
  }
  if (!candles.length) {
    return [];
  }

  const series = extractSeries(candles, source);
  const fastValues = computeSmaArray(series, fastLength);
  const slowValues = computeSmaArray(series, slowLength);
  const events: IndicatorEvent<SmaCrossoverEventPayload>[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const [fast, prevFast, slow, prevSlow] = [fastValues[i], fastValues[i - 1], slowValues[i], slowValues[i - 1]];
    if (!isFiniteNumber(fast) || !isFiniteNumber(prevFast) || !isFiniteNumber(slow) || !isFiniteNumber(prevSlow)) {
      continue;
    }

    const definition = prevFast <= prevSlow && fast > slow
      ? SMA_EVENT_DEFINITIONS.GOLDEN_CROSS
      : prevFast >= prevSlow && fast < slow
        ? SMA_EVENT_DEFINITIONS.DEATH_CROSS
        : null;
    if (definition) {
      events.push(
        createIndicatorEvent(definition, {
          candle: candles[i],
          index: i,
          payload: { fast, slow, fastLength, slowLength, source },
        }),
      );
    }
  }

  return events;
};
