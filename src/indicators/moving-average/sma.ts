import type { Candle, IndicatorEvent, LinePoint } from '../../types';
import { sma as computeSmaArray } from '../../math/sma';
import { atr as computeAtrArray } from '../../math/atr';
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
  RECLAIMED: {
    id: 'sma.reclaimed',
    name: 'SMA Reclaimed',
    description:
      'Price, settled below the SMA, closed above it by at least the ATR buffer on enough consecutive bars (default 2 closes, half an ATR).',
  },
  LOST: {
    id: 'sma.lost',
    name: 'SMA Lost',
    description:
      'Price, settled above the SMA, closed below it by at least the ATR buffer on enough consecutive bars (default 2 closes, half an ATR).',
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

export type SmaReclaimParams = {
  /** Period of the average. Default 200. */
  length?: number;
  source?: MovingAverageParams['source'];
  /** Consecutive closes beyond the buffer that confirm the change of side. Default 2. */
  confirmBars?: number;
  /** The buffer, in ATRs: a close counts only when it is at least this far beyond the average. Default 0.5. */
  atrMultiple?: number;
  /** Period of the Wilder ATR the buffer is measured in. Default 14. */
  atrLength?: number;
};

export type ResolvedSmaReclaimParams = Required<SmaReclaimParams>;

export type SmaReclaimEventPayload = {
  /** bullish for `sma.reclaimed`, bearish for `sma.lost`. */
  direction: 'bullish' | 'bearish';
  price: number;
  average: number;
  atr: number;
  /** (price - average) / atr on the confirming bar: positive for a reclaim, negative for a loss. */
  distanceAtr: number;
  /** Bars from the run that settled the previous side to the first close of this run. */
  barsOnPreviousSide: number;
  length: number;
  source: ResolvedMovingAverageParams['source'];
  confirmBars: number;
  atrMultiple: number;
  atrLength: number;
};

export const resolveSmaReclaimParams = (params: SmaReclaimParams = {}): ResolvedSmaReclaimParams => {
  const resolved: ResolvedSmaReclaimParams = {
    length: params.length ?? 200,
    source: params.source ?? 'close',
    confirmBars: params.confirmBars ?? 2,
    atrMultiple: params.atrMultiple ?? 0.5,
    atrLength: params.atrLength ?? 14,
  };
  assertPositiveInteger(resolved.length, 'length');
  assertPositiveInteger(resolved.confirmBars, 'confirmBars');
  assertPositiveInteger(resolved.atrLength, 'atrLength');
  if (!isFiniteNumber(resolved.atrMultiple) || resolved.atrMultiple < 0) {
    throw new RangeError(`atrMultiple must be a non-negative number. Received: ${resolved.atrMultiple}`);
  }
  return resolved;
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
 * averages instead of one; `detectReclaimEvents` emits the close-confirmed
 * `sma.reclaimed` / `sma.lost`.
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

/**
 * Close-confirmed reclaim and loss of one SMA (DWLF-448). A run of
 * `confirmBars` consecutive closes on one side of the average, each at least
 * `atrMultiple` Wilder ATRs beyond it, settles price on that side. When a run
 * settles price on the opposite side to before, an event fires on the run's last
 * close: `sma.reclaimed` upward, `sma.lost` downward. The first settled side
 * fires nothing, so the events alternate, and from that first run on the state
 * no longer depends on where the candles start. A close that pokes through and
 * comes straight back is not an event, unlike `sma.cross.above` / `.below`.
 * Each event uses only bars up to the one it is stamped on.
 *
 * "Reclaimed" here is the trader's sense (price won the average back). It is
 * not LevelInteraction's `reclaimed` kind (a failed break), and `sma` is not a
 * LevelInteraction prefix.
 */
export const detectReclaimEvents = (
  candles: Candle[],
  params?: SmaReclaimParams,
): IndicatorEvent<SmaReclaimEventPayload>[] => {
  const resolved = resolveSmaReclaimParams(params);
  if (!candles.length) {
    return [];
  }

  const series = extractSeries(candles, resolved.source);
  const averages = computeSmaArray(series, resolved.length);
  const ranges = computeAtrArray(candles, resolved.atrLength);
  const events: IndicatorEvent<SmaReclaimEventPayload>[] = [];
  let side = 0;
  let sideStart = -1;
  let runSide = 0;
  let run = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const [price, average, range] = [series[i], averages[i], ranges[i]];
    if (!isFiniteNumber(price) || !isFiniteNumber(average) || !isFiniteNumber(range)) {
      run = 0;
      continue;
    }
    const distance = price - average;
    const beyond = distance !== 0 && Math.abs(distance) >= resolved.atrMultiple * range ? Math.sign(distance) : 0;
    if (beyond === 0) {
      run = 0;
      continue;
    }
    run = beyond === runSide ? run + 1 : 1;
    runSide = beyond;
    if (run !== resolved.confirmBars || runSide === side) {
      continue;
    }

    const runStart = i - resolved.confirmBars + 1;
    if (side !== 0) {
      const direction = runSide > 0 ? 'bullish' : 'bearish';
      events.push(
        createIndicatorEvent(runSide > 0 ? SMA_EVENT_DEFINITIONS.RECLAIMED : SMA_EVENT_DEFINITIONS.LOST, {
          candle: candles[i],
          index: i,
          payload: {
            direction,
            price,
            average,
            atr: range,
            distanceAtr: range > 0 ? distance / range : 0,
            barsOnPreviousSide: runStart - sideStart,
            length: resolved.length,
            source: resolved.source,
            confirmBars: resolved.confirmBars,
            atrMultiple: resolved.atrMultiple,
            atrLength: resolved.atrLength,
          },
        }),
      );
    }
    side = runSide;
    sideStart = runStart;
  }

  return events;
};
