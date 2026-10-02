import type { AtrParams, Candle, IndicatorEvent, LinePoint } from '../../types';
import { atr as wilderAtr } from '../../math/atr';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';

export type ResolvedAtrParams = Required<AtrParams>;

const DEFAULT_PARAMS: ResolvedAtrParams = {
  length: 14,
  percentileWindow: 100,
  expansionPercentile: 80,
  contractionPercentile: 20,
  episodeResetPercentile: 50,
};

const ATR_EVENT_DEFINITIONS = {
  EXPANSION: {
    id: 'atr.regime.expansion',
    name: 'Volatility Expansion',
    description:
      'ATR as a percent of close rose into the top band of its recent range (percentile crossed up through the expansion threshold).',
  },
  CONTRACTION: {
    id: 'atr.regime.contraction',
    name: 'Volatility Contraction',
    description:
      'ATR as a percent of close fell into the bottom band of its recent range (percentile crossed down through the contraction threshold).',
  },
} as const;

const assertPercentile = (value: number, name: string): void => {
  if (!isFiniteNumber(value) || value <= 0 || value >= 100) {
    throw new TypeError(`${name} must be between 0 and 100 (exclusive). Received: ${value}`);
  }
};

export const resolveAtrParams = (params: AtrParams = {}): ResolvedAtrParams => {
  const resolved: ResolvedAtrParams = {
    length: params.length ?? DEFAULT_PARAMS.length,
    percentileWindow: params.percentileWindow ?? DEFAULT_PARAMS.percentileWindow,
    expansionPercentile: params.expansionPercentile ?? DEFAULT_PARAMS.expansionPercentile,
    contractionPercentile: params.contractionPercentile ?? DEFAULT_PARAMS.contractionPercentile,
    episodeResetPercentile: params.episodeResetPercentile ?? DEFAULT_PARAMS.episodeResetPercentile,
  };

  assertPositiveInteger(resolved.length, 'length');
  assertPositiveInteger(resolved.percentileWindow, 'percentileWindow');
  if (resolved.percentileWindow < 2) {
    throw new TypeError(`percentileWindow must be at least 2. Received: ${resolved.percentileWindow}`);
  }
  assertPercentile(resolved.expansionPercentile, 'expansionPercentile');
  assertPercentile(resolved.contractionPercentile, 'contractionPercentile');
  assertPercentile(resolved.episodeResetPercentile, 'episodeResetPercentile');
  if (
    !(resolved.contractionPercentile < resolved.episodeResetPercentile
      && resolved.episodeResetPercentile < resolved.expansionPercentile)
  ) {
    throw new TypeError(
      'Percentiles must satisfy contractionPercentile < episodeResetPercentile < expansionPercentile.',
    );
  }
  // Midrank counts the current value as half a tie, so a full window ranks
  // between 50/window and 100 - 50/window; a threshold outside that never fires.
  const edge = 50 / resolved.percentileWindow;
  if (resolved.expansionPercentile > 100 - edge || resolved.contractionPercentile < edge) {
    throw new TypeError(
      `With percentileWindow ${resolved.percentileWindow}, thresholds must lie within [${edge}, ${100 - edge}].`,
    );
  }

  return resolved;
};

/**
 * ATR as a percent of each candle's close. Undefined for a non-positive
 * close: a negative divisor would invert the ranking, so instruments that can
 * print negative prices get no percent (and no regime events) on those bars.
 */
const toPercentOfClose = (candles: Candle[], values: Array<number | undefined>): Array<number | undefined> =>
  values.map((value, i) => {
    const close = candles[i].c;
    if (!isFiniteNumber(value) || !isFiniteNumber(close) || close <= 0) {
      return undefined;
    }
    return (value / close) * 100;
  });

/**
 * Percentile rank (0-100) of each value within the trailing `window` values
 * ending at it, by midrank: values below count fully and ties (the value
 * itself included) count half, so a flat window ranks 50, not 100.
 * Gaps (non-finite values) are left out of the ranking; a bar's rank is
 * undefined until `window` bars have passed, or while fewer than half the
 * window's values are finite.
 */
const trailingPercentileRank = (values: Array<number | undefined>, window: number): Array<number | undefined> =>
  values.map((value, i) => {
    if (!isFiniteNumber(value) || i + 1 < window) {
      return undefined;
    }
    let below = 0;
    let ties = 0;
    let counted = 0;
    for (let j = i - window + 1; j <= i; j += 1) {
      const other = values[j];
      if (!isFiniteNumber(other)) {
        continue;
      }
      counted += 1;
      if (other < value) {
        below += 1;
      } else if (other === value) {
        ties += 1;
      }
    }
    if (counted * 2 < window) {
      return undefined;
    }
    return ((below + ties / 2) / counted) * 100;
  });

export type AtrResult = {
  atr: LinePoint[];
  atrPercent: LinePoint[];
  params: ResolvedAtrParams;
};

export type AtrRegimePayload = {
  atr: number;
  atrPercent: number;
  percentile: number;
  threshold: number;
  length: number;
  percentileWindow: number;
};

export const computeAtr = (candles: Candle[], params?: AtrParams): AtrResult => {
  const resolved = resolveAtrParams(params);
  const values = wilderAtr(candles, resolved.length);
  return {
    atr: toLinePoints(candles, values),
    atrPercent: toLinePoints(candles, toPercentOfClose(candles, values)),
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(ATR_EVENT_DEFINITIONS);

/**
 * Fires once per episode, at the bar whose close completes the crossing:
 * expansion when the ATR% percentile reaches `expansionPercentile`,
 * contraction when it falls to `contractionPercentile`. An episode ends only
 * when the percentile returns past `episodeResetPercentile`, so a series
 * hovering at a threshold does not fire on every bar. The episode state needs
 * `length + percentileWindow - 1` bars before the first rank, then is fixed by
 * the last reset crossing, so callers should pass enough history for one. ATR is taken as a percent of close so
 * the comparison window is not skewed by a trend in price. A series that is
 * already past a threshold when its first percentile is known starts inside
 * that episode, without firing.
 */
export const detectEvents = (candles: Candle[], params?: AtrParams): IndicatorEvent<AtrRegimePayload>[] => {
  const resolved = resolveAtrParams(params);
  if (candles.length === 0) {
    return [];
  }

  const values = wilderAtr(candles, resolved.length);
  const percents = toPercentOfClose(candles, values);
  const ranks = trailingPercentileRank(percents, resolved.percentileWindow);
  const events: IndicatorEvent<AtrRegimePayload>[] = [];
  let episode: 'expanded' | 'contracted' | 'normal' | undefined;

  for (let i = 0; i < candles.length; i += 1) {
    const rank = ranks[i];
    const value = values[i];
    const percent = percents[i];
    // A bar without a rank is skipped; the episode carries across the gap.
    if (!isFiniteNumber(rank) || !isFiniteNumber(value) || !isFiniteNumber(percent)) {
      continue;
    }

    const reachedExpansion = rank >= resolved.expansionPercentile;
    const reachedContraction = rank <= resolved.contractionPercentile;

    if (episode === undefined) {
      episode = reachedExpansion ? 'expanded' : reachedContraction ? 'contracted' : 'normal';
      continue;
    }

    const fire = (definition: typeof ATR_EVENT_DEFINITIONS.EXPANSION | typeof ATR_EVENT_DEFINITIONS.CONTRACTION, threshold: number) =>
      events.push(
        createIndicatorEvent(definition, {
          candle: candles[i],
          index: i,
          payload: {
            atr: value,
            atrPercent: percent,
            percentile: rank,
            threshold,
            length: resolved.length,
            percentileWindow: resolved.percentileWindow,
          },
        }),
      );

    if (episode !== 'expanded' && reachedExpansion) {
      fire(ATR_EVENT_DEFINITIONS.EXPANSION, resolved.expansionPercentile);
      episode = 'expanded';
    } else if (episode !== 'contracted' && reachedContraction) {
      fire(ATR_EVENT_DEFINITIONS.CONTRACTION, resolved.contractionPercentile);
      episode = 'contracted';
    } else if (episode === 'expanded' && rank < resolved.episodeResetPercentile) {
      episode = 'normal';
    } else if (episode === 'contracted' && rank > resolved.episodeResetPercentile) {
      episode = 'normal';
    }
  }

  return events;
};
