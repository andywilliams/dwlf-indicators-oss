import type { Candle, IndicatorEvent, LinePoint, RsiParams } from '../../types';
import { rsi as wilderRsi } from '../../math/rsi';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';

export type ResolvedRsiParams = Required<RsiParams>;

const DEFAULT_PARAMS: ResolvedRsiParams = {
  length: 14,
  overbought: 70,
  oversold: 30,
  midline: 50,
};

// Exits share the `dss.exit.*` shape and meaning. The midline cross is not
// `rsi.cross.*`: `dss.cross.*` means a signal-line cross, and RSI has none.
const RSI_EVENT_DEFINITIONS = {
  EXIT_OVERBOUGHT: {
    id: 'rsi.exit.overbought',
    name: 'RSI Left Overbought Zone',
    description: 'RSI closed back below the overbought level after being at or above it.',
  },
  EXIT_OVERSOLD: {
    id: 'rsi.exit.oversold',
    name: 'RSI Left Oversold Zone',
    description: 'RSI closed back above the oversold level after being at or below it.',
  },
  MIDLINE_BULLISH: {
    id: 'rsi.midline.bullish',
    name: 'RSI Crossed Above Midline',
    description: 'RSI closed at or above the midline (50 by default) after being below it.',
  },
  MIDLINE_BEARISH: {
    id: 'rsi.midline.bearish',
    name: 'RSI Crossed Below Midline',
    description: 'RSI closed below the midline (50 by default) after being at or above it.',
  },
} as const;

const assertLevel = (value: number, name: string): void => {
  if (!isFiniteNumber(value) || value <= 0 || value >= 100) {
    throw new TypeError(`${name} must be between 0 and 100 (exclusive). Received: ${value}`);
  }
};

export const resolveRsiParams = (params: RsiParams = {}): ResolvedRsiParams => {
  const resolved: ResolvedRsiParams = {
    length: params.length ?? DEFAULT_PARAMS.length,
    overbought: params.overbought ?? DEFAULT_PARAMS.overbought,
    oversold: params.oversold ?? DEFAULT_PARAMS.oversold,
    midline: params.midline ?? DEFAULT_PARAMS.midline,
  };

  assertPositiveInteger(resolved.length, 'length');
  assertLevel(resolved.overbought, 'overbought');
  assertLevel(resolved.oversold, 'oversold');
  assertLevel(resolved.midline, 'midline');
  if (!(resolved.oversold < resolved.midline && resolved.midline < resolved.overbought)) {
    throw new TypeError('Levels must satisfy oversold < midline < overbought.');
  }

  return resolved;
};

export type RsiResult = {
  rsi: LinePoint[];
  params: ResolvedRsiParams;
};

export type RsiEventPayload = {
  rsi: number;
  previous: number;
  level: number;
  length: number;
};

export const computeRsi = (candles: Candle[], params?: RsiParams): RsiResult => {
  const resolved = resolveRsiParams(params);
  return {
    rsi: toLinePoints(candles, wilderRsi(candles, resolved.length)),
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(RSI_EVENT_DEFINITIONS);

/**
 * Each event fires on the bar whose close completes the crossing, comparing it
 * with the previous bar that has a value (a gap restarts the RSI, so the first
 * value after one has no previous and fires nothing).
 */
export const detectEvents = (candles: Candle[], params?: RsiParams): IndicatorEvent<RsiEventPayload>[] => {
  const resolved = resolveRsiParams(params);
  const values = wilderRsi(candles, resolved.length);
  const events: IndicatorEvent<RsiEventPayload>[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const current = values[i];
    const previous = values[i - 1];
    if (!isFiniteNumber(current) || !isFiniteNumber(previous)) {
      continue;
    }

    const fire = (definition: (typeof RSI_EVENT_DEFINITIONS)[keyof typeof RSI_EVENT_DEFINITIONS], level: number) =>
      events.push(
        createIndicatorEvent(definition, {
          candle: candles[i],
          index: i,
          payload: { rsi: current, previous, level, length: resolved.length },
        }),
      );

    if (previous >= resolved.overbought && current < resolved.overbought) {
      fire(RSI_EVENT_DEFINITIONS.EXIT_OVERBOUGHT, resolved.overbought);
    }
    if (previous <= resolved.oversold && current > resolved.oversold) {
      fire(RSI_EVENT_DEFINITIONS.EXIT_OVERSOLD, resolved.oversold);
    }
    if (previous < resolved.midline && current >= resolved.midline) {
      fire(RSI_EVENT_DEFINITIONS.MIDLINE_BULLISH, resolved.midline);
    } else if (previous >= resolved.midline && current < resolved.midline) {
      fire(RSI_EVENT_DEFINITIONS.MIDLINE_BEARISH, resolved.midline);
    }
  }

  return events;
};
