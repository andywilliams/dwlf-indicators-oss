import type { AdxParams, Candle, IndicatorEvent, LinePoint } from '../../types';
import { dmi } from '../../math/adx';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';

export type ResolvedAdxParams = Required<AdxParams>;

const DEFAULT_PARAMS: ResolvedAdxParams = {
  length: 14,
  trendLevel: 25,
  fadeLevel: 20,
  crossMinAdx: 20,
};

// One `adx.` prefix for every id, so the module owns one namespace. The trend
// events use hysteresis (start at 25, fade below 20) so ADX hovering near one
// level does not flicker; the DI crosses fire only while ADX shows a trend.
const ADX_EVENT_DEFINITIONS = {
  TREND_STARTED_BULLISH: {
    id: 'adx.trend.started.bullish',
    name: 'ADX Trend Started (Bullish)',
    description: 'ADX rose to the trend level (25 by default) with +DI above -DI: a trend is under way, upward.',
  },
  TREND_STARTED_BEARISH: {
    id: 'adx.trend.started.bearish',
    name: 'ADX Trend Started (Bearish)',
    description: 'ADX rose to the trend level (25 by default) with -DI above +DI: a trend is under way, downward.',
  },
  TREND_FADED: {
    id: 'adx.trend.faded',
    name: 'ADX Trend Faded',
    description: 'ADX fell below the fade level (20 by default) after a trend start: price is ranging again.',
  },
  DI_CROSS_BULLISH: {
    id: 'adx.di.cross.bullish',
    name: 'DMI Bullish Cross',
    description: '+DI crossed above -DI while ADX was at or above its cross level (20 by default).',
  },
  DI_CROSS_BEARISH: {
    id: 'adx.di.cross.bearish',
    name: 'DMI Bearish Cross',
    description: '-DI crossed above +DI while ADX was at or above its cross level (20 by default).',
  },
} as const;

const assertLevel = (value: number, name: string): void => {
  if (!isFiniteNumber(value) || value < 0 || value > 100) {
    throw new TypeError(`${name} must be between 0 and 100. Received: ${value}`);
  }
};

export const resolveAdxParams = (params: AdxParams = {}): ResolvedAdxParams => {
  const resolved: ResolvedAdxParams = {
    length: params.length ?? DEFAULT_PARAMS.length,
    trendLevel: params.trendLevel ?? DEFAULT_PARAMS.trendLevel,
    fadeLevel: params.fadeLevel ?? DEFAULT_PARAMS.fadeLevel,
    crossMinAdx: params.crossMinAdx ?? DEFAULT_PARAMS.crossMinAdx,
  };

  assertPositiveInteger(resolved.length, 'length');
  assertLevel(resolved.trendLevel, 'trendLevel');
  assertLevel(resolved.fadeLevel, 'fadeLevel');
  assertLevel(resolved.crossMinAdx, 'crossMinAdx');
  if (resolved.fadeLevel > resolved.trendLevel) {
    throw new TypeError('fadeLevel must not be above trendLevel.');
  }

  return resolved;
};

export type AdxResult = {
  adx: LinePoint[];
  plusDI: LinePoint[];
  minusDI: LinePoint[];
  params: ResolvedAdxParams;
};

export type AdxEventPayload = {
  /** bullish when +DI is above -DI on the bar, bearish when below; faded carries the side it faded from. */
  direction: 'bullish' | 'bearish';
  adx: number;
  previousAdx: number;
  plusDI: number;
  minusDI: number;
  /** Trend events only: the level crossed. */
  threshold?: number;
  length: number;
};

export const computeADX = (candles: Candle[], params?: AdxParams): AdxResult => {
  const resolved = resolveAdxParams(params);
  const series = dmi(candles, resolved.length);
  return {
    adx: toLinePoints(candles, series.adx),
    plusDI: toLinePoints(candles, series.plusDI),
    minusDI: toLinePoints(candles, series.minusDI),
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(ADX_EVENT_DEFINITIONS);

/**
 * Trend events run a two-state machine on ADX:
 * - ranging → trending when ADX closes at or above `trendLevel` after being below
 *   it (`adx.trend.started.bullish` / `.bearish`, by which DI is on top);
 * - trending → ranging when ADX closes below `fadeLevel` (`adx.trend.faded`).
 * The first ADX value sets the state without an event (trending if it is at or
 * above `trendLevel`), and a gap in the series starts it again, as the DMI does.
 * Give it history: ADX needs 2 * length - 1 bars to start, its Wilder smoothing
 * forgets its start by about (1 - 1/length) per bar, and the state agrees across
 * window starts from the first trend start or fade they share. A 400-bar daily
 * window is ample. `adx.trend.faded` names no side in its id (price is ranging
 * again); its payload `direction` is the side of the trend that faded.
 * `adx.di.cross.*` fire when the DIs cross while ADX is at or above `crossMinAdx`.
 * Each event uses only bars up to the one it is stamped on.
 */
export const detectEvents = (candles: Candle[], params?: AdxParams): IndicatorEvent<AdxEventPayload>[] => {
  const resolved = resolveAdxParams(params);
  const { adx, plusDI, minusDI } = dmi(candles, resolved.length);
  const events: IndicatorEvent<AdxEventPayload>[] = [];
  let trending: boolean | undefined;
  let trendDirection: 'bullish' | 'bearish' = 'bullish';

  for (let i = 0; i < candles.length; i += 1) {
    const [current, plus, minus] = [adx[i], plusDI[i], minusDI[i]];
    if (!isFiniteNumber(current) || !isFiniteNumber(plus) || !isFiniteNumber(minus)) {
      trending = undefined;
      continue;
    }
    const previous = adx[i - 1];
    if (trending === undefined || !isFiniteNumber(previous)) {
      trending = current >= resolved.trendLevel;
      trendDirection = plus >= minus ? 'bullish' : 'bearish';
      continue;
    }

    const direction = plus >= minus ? 'bullish' : 'bearish';
    const fire = (
      definition: (typeof ADX_EVENT_DEFINITIONS)[keyof typeof ADX_EVENT_DEFINITIONS],
      eventDirection: 'bullish' | 'bearish',
      threshold?: number,
    ) =>
      events.push(
        createIndicatorEvent(definition, {
          candle: candles[i],
          index: i,
          payload: {
            direction: eventDirection,
            adx: current,
            previousAdx: previous,
            plusDI: plus,
            minusDI: minus,
            ...(threshold === undefined ? {} : { threshold }),
            length: resolved.length,
          },
        }),
      );

    if (!trending && previous < resolved.trendLevel && current >= resolved.trendLevel) {
      trending = true;
      trendDirection = direction;
      fire(
        direction === 'bullish' ? ADX_EVENT_DEFINITIONS.TREND_STARTED_BULLISH : ADX_EVENT_DEFINITIONS.TREND_STARTED_BEARISH,
        direction,
        resolved.trendLevel,
      );
    } else if (trending && current < resolved.fadeLevel) {
      trending = false;
      fire(ADX_EVENT_DEFINITIONS.TREND_FADED, trendDirection, resolved.fadeLevel);
    }

    const [previousPlus, previousMinus] = [plusDI[i - 1], minusDI[i - 1]];
    if (current >= resolved.crossMinAdx && isFiniteNumber(previousPlus) && isFiniteNumber(previousMinus)) {
      if (previousPlus <= previousMinus && plus > minus) {
        fire(ADX_EVENT_DEFINITIONS.DI_CROSS_BULLISH, 'bullish');
      } else if (previousPlus >= previousMinus && plus < minus) {
        fire(ADX_EVENT_DEFINITIONS.DI_CROSS_BEARISH, 'bearish');
      }
    }
  }

  return events;
};
