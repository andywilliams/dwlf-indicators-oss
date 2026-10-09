import type { Candle, BollingerParams, IndicatorEvent, LinePoint } from '../../types';
import { ema as computeEmaArray } from '../../math/ema';
import { sma as computeSmaArray } from '../../math/sma';
import { standardDeviation } from '../../math/stddev';
import { trailingPercentileRank } from '../../math/percentile';
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
  SQUEEZE: {
    id: 'bollinger.squeeze',
    name: 'Bollinger Squeeze',
    description: 'Band width fell into the bottom of its recent range (default: 20th percentile of the last 120 bars): volatility is compressed.',
  },
  SQUEEZE_RELEASED: {
    id: 'bollinger.squeeze.released',
    name: 'Bollinger Squeeze Released',
    description: 'After a squeeze, band width rose back to the middle of its recent range (default: 50th percentile): volatility is expanding again.',
  },
  REENTRY_FROM_ABOVE: {
    id: 'bollinger.reentry.fromAbove',
    name: 'Close Re-entered From Above Upper Band',
    description: 'After a close above the upper band, price closed back inside or at it.',
  },
  REENTRY_FROM_BELOW: {
    id: 'bollinger.reentry.fromBelow',
    name: 'Close Re-entered From Below Lower Band',
    description: 'After a close below the lower band, price closed back inside or at it.',
  },
} as const;

const SQUEEZE_DEFAULTS = { squeezePercentile: 20, releasePercentile: 50, percentileWindow: 120 };

/**
 * Event-detection options. They only decide which bars are events: they never
 * reach `computeBollingerBands` or its resolved `params`.
 */
export type BollingerEventParams = BollingerParams & {
  /** Band-width percentile at or below which a squeeze begins. Default 20. */
  squeezePercentile?: number;
  /** Band-width percentile a squeeze must rise to before it is released. Default 50. */
  releasePercentile?: number;
  /** How many bars the band-width percentile is ranked over. Default 120. */
  percentileWindow?: number;
};

type SqueezeLevels = typeof SQUEEZE_DEFAULTS;

const resolveSqueezeLevels = (params: BollingerEventParams = {}): SqueezeLevels => {
  const levels = {
    squeezePercentile: params.squeezePercentile ?? SQUEEZE_DEFAULTS.squeezePercentile,
    releasePercentile: params.releasePercentile ?? SQUEEZE_DEFAULTS.releasePercentile,
    percentileWindow: params.percentileWindow ?? SQUEEZE_DEFAULTS.percentileWindow,
  };
  assertPositiveInteger(levels.percentileWindow, 'percentileWindow');
  const { squeezePercentile: squeeze, releasePercentile: release, percentileWindow: window } = levels;
  if (!isFiniteNumber(squeeze) || !isFiniteNumber(release) || squeeze <= 0 || release >= 100 || squeeze >= release) {
    throw new TypeError(
      `Squeeze levels must satisfy 0 < squeezePercentile < releasePercentile < 100. Received: squeezePercentile=${squeeze}, releasePercentile=${release}`,
    );
  }
  // A midrank over `window` values spans 50/window to 100 − 50/window; a level
  // outside that can never be reached, and its event would silently never fire.
  if (squeeze < 50 / window || release > 100 - 50 / window) {
    throw new TypeError(
      `percentileWindow ${window} ranks between ${50 / window} and ${100 - 50 / window}; squeezePercentile=${squeeze} and releasePercentile=${release} must both be reachable`,
    );
  }
  return levels;
};

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

export type BollingerSqueezePayload = {
  /** (upper − lower) / middle. */
  bandwidth: number;
  /** Percentile of `bandwidth` within the trailing window. */
  percentile: number;
  /** The percentile the event is judged against. */
  threshold: number;
  /** On a release: which side of the middle band price closed. */
  direction?: 'up' | 'down';
};

export type BollingerReentryPayload = {
  price: number;
  bandValue: number;
  band: 'upper' | 'lower';
  source: ResolvedBollingerParams['source'];
};

export type BollingerEventPayload = BollingerBandBreakPayload | BollingerSqueezePayload | BollingerReentryPayload;

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
  params?: BollingerEventParams,
): IndicatorEvent<BollingerEventPayload>[] => {
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

  const events: IndicatorEvent<BollingerEventPayload>[] = [];

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

  const bands = { series, upper: upperValues, middle: basisValues, lower: lowerValues };
  events.push(
    ...detectSqueezeEvents(candles, bands, resolveSqueezeLevels(params), resolveTargetIndex),
    ...detectReentryEvents(candles, bands, resolved.source, resolveTargetIndex),
  );
  return events.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
};

type BandSeries = {
  series: Array<number | undefined>;
  upper: Array<number | undefined>;
  middle: Array<number | undefined>;
  lower: Array<number | undefined>;
};

const bandwidthAt = ({ upper, middle, lower }: BandSeries, i: number): number | undefined => {
  const [u, m, l] = [upper[i], middle[i], lower[i]];
  // A width relative to a basis at or below zero has no meaning: a wider band
  // would rank lower and read as a squeeze.
  return isFiniteNumber(u) && isFiniteNumber(m) && isFiniteNumber(l) && m > 0 ? (u - l) / m : undefined;
};

/**
 * A squeeze begins when band width ranks at or below `squeezePercentile` of its
 * trailing window, and is released once it ranks at or above
 * `releasePercentile` — the gap between them stops one squeeze from firing over
 * and over as width hovers at the line. The first ranked bar only sets the
 * state, so a history never opens on an event. Like the breaks, an event is
 * placed where its band is plotted (`offset` bars on) and read against the
 * price there.
 */
const detectSqueezeEvents = (
  candles: Candle[],
  bands: BandSeries,
  levels: SqueezeLevels,
  targetOf: (index: number) => number | null,
): IndicatorEvent<BollingerSqueezePayload>[] => {
  const widths = candles.map((_, i) => bandwidthAt(bands, i));
  const ranks = trailingPercentileRank(widths, levels.percentileWindow);
  const events: IndicatorEvent<BollingerSqueezePayload>[] = [];
  let squeezed: boolean | undefined;

  for (let i = 0; i < candles.length; i += 1) {
    const [rank, width] = [ranks[i], widths[i]];
    if (!isFiniteNumber(rank) || !isFiniteNumber(width)) {
      continue;
    }
    if (squeezed === undefined) {
      squeezed = rank <= levels.squeezePercentile;
      continue;
    }
    const target = targetOf(i);
    if (!squeezed && rank <= levels.squeezePercentile) {
      squeezed = true;
      if (target !== null) {
        events.push(createIndicatorEvent(BOLLINGER_EVENT_DEFINITIONS.SQUEEZE, {
          candle: candles[target],
          index: target,
          payload: { bandwidth: width, percentile: rank, threshold: levels.squeezePercentile },
        }));
      }
    } else if (squeezed && rank >= levels.releasePercentile) {
      squeezed = false;
      if (target === null) {
        continue;
      }
      const [price, middle] = [bands.series[target], bands.middle[i]];
      events.push(createIndicatorEvent(BOLLINGER_EVENT_DEFINITIONS.SQUEEZE_RELEASED, {
        candle: candles[target],
        index: target,
        payload: {
          bandwidth: width,
          percentile: rank,
          threshold: levels.releasePercentile,
          ...(isFiniteNumber(price) && isFiniteNumber(middle) ? { direction: price >= middle ? 'up' as const : 'down' as const } : {}),
        },
      }));
    }
  }
  return events;
};

/**
 * A close back inside a band after a close outside it, on consecutive bars.
 * Aligned like the breaks: the band at `i` against the price where it is
 * plotted (`offset` bars on).
 */
const detectReentryEvents = (
  candles: Candle[],
  bands: BandSeries,
  source: ResolvedBollingerParams['source'],
  targetOf: (index: number) => number | null,
): IndicatorEvent<BollingerReentryPayload>[] => {
  const events: IndicatorEvent<BollingerReentryPayload>[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const [target, prevTarget] = [targetOf(i), targetOf(i - 1)];
    if (target === null || prevTarget === null) {
      continue;
    }
    const [price, prevPrice] = [bands.series[target], bands.series[prevTarget]];
    if (!isFiniteNumber(price) || !isFiniteNumber(prevPrice)) {
      continue;
    }
    const [upper, prevUpper, lower, prevLower] = [bands.upper[i], bands.upper[i - 1], bands.lower[i], bands.lower[i - 1]];
    if (isFiniteNumber(upper) && isFiniteNumber(prevUpper) && prevPrice > prevUpper && price <= upper) {
      events.push(createIndicatorEvent(BOLLINGER_EVENT_DEFINITIONS.REENTRY_FROM_ABOVE, {
        candle: candles[target],
        index: target,
        payload: { price, bandValue: upper, band: 'upper', source },
      }));
    }
    if (isFiniteNumber(lower) && isFiniteNumber(prevLower) && prevPrice < prevLower && price >= lower) {
      events.push(createIndicatorEvent(BOLLINGER_EVENT_DEFINITIONS.REENTRY_FROM_BELOW, {
        candle: candles[target],
        index: target,
        payload: { price, bandValue: lower, band: 'lower', source },
      }));
    }
  }
  return events;
};
