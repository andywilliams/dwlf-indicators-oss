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
    description: 'ADX fell below the fade level (20 by default) while trending: price is ranging again.',
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
  /** bullish when +DI is above -DI on the bar (the last side they were on, if equal), bearish when below. A fade carries the side its trend started on. */
  direction: 'bullish' | 'bearish';
  adx: number;
  /** ADX on the previous bar; absent on the first bar with an ADX value. */
  previousAdx?: number;
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
 * Between the two levels nothing changes, so ADX hovering near one level does
 * not flicker. The first ADX value sets the state without an event; a trend
 * already under way there still reports its fade (its start lies before the
 * candles), so a run that starts mid-trend agrees with one that saw the start.
 * A gap in the series starts the state again, as the DMI math does.
 * `adx.di.cross.*` fire when the DIs change sides while ADX is at or above
 * `crossMinAdx`; a bar where they are equal is on neither side.
 * Each event uses only bars up to the one it is stamped on. Runs that start on
 * different bars agree once two things have happened: the Wilder smoothing has
 * forgotten its start (it decays by about (1 - 1/length) per bar), and ADX has
 * since left the band between the levels (closing below `fadeLevel` or at or above
 * `trendLevel` sets both runs' state the same way). So give the detector history;
 * a 400-bar daily window leaves hundreds of bars for both.
 * `adx.trend.faded` names no side in its id (price is ranging again); its
 * payload `direction` is the side the trend started on. A trend that reverses
 * without ADX falling below `fadeLevel` (a V-top) shows as an `adx.di.cross.*`
 * in between; the fade still names the trend that began.
 */
export const detectEvents = (candles: Candle[], params?: AdxParams): IndicatorEvent<AdxEventPayload>[] => {
  const resolved = resolveAdxParams(params);
  const { adx, plusDI, minusDI } = dmi(candles, resolved.length);
  const events: IndicatorEvent<AdxEventPayload>[] = [];
  // undefined: no ADX yet (or after a gap).
  let trending: boolean | undefined;
  // The side the trend started on (or, for a trend under way at the first bar, the DIs' side there).
  let trendDirection: 'bullish' | 'bearish' = 'bullish';
  // The side the DIs were last on (+1 / -1), ignoring bars where they are equal.
  let diSide = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const [plus, minus] = [plusDI[i], minusDI[i]];
    if (!isFiniteNumber(plus) || !isFiniteNumber(minus)) {
      trending = undefined;
      diSide = 0;
      continue;
    }
    const side = Math.sign(plus - minus);
    const crossed = side !== 0 && diSide !== 0 && side !== diSide;
    if (side !== 0) {
      diSide = side;
    }
    const current = adx[i];
    if (!isFiniteNumber(current)) {
      continue;
    }

    const previous = adx[i - 1];
    const direction: 'bullish' | 'bearish' = diSide >= 0 ? 'bullish' : 'bearish';
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
            ...(isFiniteNumber(previous) ? { previousAdx: previous } : {}),
            plusDI: plus,
            minusDI: minus,
            ...(threshold === undefined ? {} : { threshold }),
            length: resolved.length,
          },
        }),
      );

    if (trending === undefined || !isFiniteNumber(previous)) {
      trending = current >= resolved.trendLevel;
      trendDirection = direction;
    } else if (!trending && previous < resolved.trendLevel && current >= resolved.trendLevel) {
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

    if (crossed && current >= resolved.crossMinAdx) {
      fire(side > 0 ? ADX_EVENT_DEFINITIONS.DI_CROSS_BULLISH : ADX_EVENT_DEFINITIONS.DI_CROSS_BEARISH, side > 0 ? 'bullish' : 'bearish');
    }
  }

  return events;
};
