import type { Candle, DssParams, IndicatorEvent, LinePoint } from '../../types';
import { ema } from '../../math/ema';
import { rollingHighest, rollingLowest } from '../../math/rolling';
import {
  assertPositiveInteger,
  clamp,
  isFiniteNumber,
  toFiniteOr,
} from '../../utils/guards';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';

export type ResolvedDssParams = Required<DssParams>;

const DEFAULT_PARAMS: ResolvedDssParams = {
  length: 13,
  smooth1: 8,
  signal: 3,
};

const OVERBOUGHT_LEVEL = 80;
const OVERSOLD_LEVEL = 20;

const DSS_EVENT_DEFINITIONS = {
  BULLISH_CROSS: {
    id: 'dss.cross.bullish',
    name: 'DSS Crossed Above Signal',
    description: 'The DSS line crossed above the signal, indicating bullish momentum.',
  },
  BEARISH_CROSS: {
    id: 'dss.cross.bearish',
    name: 'DSS Crossed Below Signal',
    description: 'The DSS line crossed below the signal, indicating bearish momentum.',
  },
  ENTER_OVERBOUGHT: {
    id: 'dss.level.overbought',
    name: 'DSS Entered Overbought Zone',
    description: `The DSS line moved above ${OVERBOUGHT_LEVEL}, signalling potential overbought conditions.`,
  },
  ENTER_OVERSOLD: {
    id: 'dss.level.oversold',
    name: 'DSS Entered Oversold Zone',
    description: `The DSS line moved below ${OVERSOLD_LEVEL}, signalling potential oversold conditions.`,
  },
} as const;

export type DssCrossEventPayload = {
  dss: number;
  signal: number;
  direction: 'bullish' | 'bearish';
};

export type DssThresholdEventPayload = {
  dss: number;
  threshold: number;
  state: 'overbought' | 'oversold';
};

export type DssEventPayload = DssCrossEventPayload | DssThresholdEventPayload;

export const resolveDssParams = (params: DssParams = {}): ResolvedDssParams => {
  const resolved: ResolvedDssParams = {
    length: params.length ?? DEFAULT_PARAMS.length,
    smooth1: params.smooth1 ?? DEFAULT_PARAMS.smooth1,
    signal: params.signal ?? DEFAULT_PARAMS.signal,
  };

  assertPositiveInteger(resolved.length, 'length');
  assertPositiveInteger(resolved.smooth1, 'smooth1');
  assertPositiveInteger(resolved.signal, 'signal');

  return resolved;
};

/**
 * Computes a %K-style stochastic (0–100) over an arbitrary numeric series.
 * Uses a rolling window over the provided `series` and returns an array of numbers or undefined.
 * Non-finite values are treated as gaps; when the window contains no finite values, the previous carry is used.
 */
const computeSeriesStoch = (series: Array<number | undefined>, length: number): Array<number | undefined> => {
  const out: Array<number | undefined> = Array.from({ length: series.length }, () => undefined);
  let carry = 50;
  for (let i = 0; i < series.length; i += 1) {
    if (i < length - 1) continue;
    // Find highest/lowest over the last `length` points, skipping undefined
    let hh = -Infinity;
    let ll = Infinity;
    let hasFinite = false;
    for (let j = i - length + 1; j <= i; j += 1) {
      const v = series[j];
      if (isFiniteNumber(v)) {
        hasFinite = true;
        if (v > hh) hh = v!;
        if (v < ll) ll = v!;
      }
    }
    if (!hasFinite) { out[i] = carry; continue; }
    const cur = series[i];
    if (!isFiniteNumber(cur)) { out[i] = carry; continue; }
    const range = hh - ll;
    if (range === 0) { out[i] = carry; continue; }
    const k = clamp(((cur - ll) / range) * 100, 0, 100);
    carry = toFiniteOr(k, carry);
    out[i] = carry;
  }
  return out;
};

const computeRawValues = (candles: Candle[], length: number): Array<number | undefined> => {
  const highs = candles.map((candle) => candle.h);
  const lows = candles.map((candle) => candle.l);
  const result: Array<number | undefined> = Array.from({ length: candles.length }, () => undefined);
  let carry = 50;

  for (let i = 0; i < candles.length; i += 1) {
    if (i < length - 1) {
      continue;
    }

    const highest = rollingHighest(highs, i, length);
    const lowest = rollingLowest(lows, i, length);
    const candle = candles[i];

    if (!isFiniteNumber(highest) || !isFiniteNumber(lowest)) {
      result[i] = carry;
      continue;
    }

    const range = highest - lowest;
    if (range === 0) {
      result[i] = carry;
      continue;
    }

    const normalized = ((candle.c - lowest) / range) * 100;
    const guarded = clamp(normalized, 0, 100);
    carry = toFiniteOr(guarded, carry);
    result[i] = carry;
  }

  return result;
};

const computeDssSeries = (
  candles: Candle[],
  resolved: ResolvedDssParams,
): { dssArr: Array<number | undefined>; sigArr: Array<number | undefined> } => {
  const raw1 = computeRawValues(candles, resolved.length);
  const pre = ema(raw1, resolved.smooth1);
  const raw2 = computeSeriesStoch(pre, resolved.length);
  const dssArr = ema(raw2, resolved.smooth1);
  const sigArr = ema(dssArr, resolved.signal);
  return { dssArr, sigArr };
};

export type DssResult = {
  dss: LinePoint[];
  signal: LinePoint[];
  params: ResolvedDssParams;
};

export const computeDSS = (candles: Candle[], params?: DssParams): DssResult => {
  if (candles.length === 0) {
    return {
      dss: [],
      signal: [],
      params: resolveDssParams(params),
    };
  }

  const resolved = resolveDssParams(params);
  const { dssArr, sigArr } = computeDssSeries(candles, resolved);

  return {
    dss: toLinePoints(candles, dssArr),
    signal: toLinePoints(candles, sigArr),
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(DSS_EVENT_DEFINITIONS);

export const detectEvents = (
  candles: Candle[],
  params?: DssParams,
): IndicatorEvent<DssEventPayload>[] => {
  if (candles.length === 0) {
    return [];
  }

  const resolved = resolveDssParams(params);
  const { dssArr, sigArr } = computeDssSeries(candles, resolved);
  const events: IndicatorEvent<DssEventPayload>[] = [];

  for (let i = 1; i < dssArr.length; i += 1) {
    const dss = dssArr[i];
    const prevDss = dssArr[i - 1];
    const signal = sigArr[i];
    const prevSignal = sigArr[i - 1];

    if (
      !isFiniteNumber(dss) ||
      !isFiniteNumber(prevDss) ||
      !isFiniteNumber(signal) ||
      !isFiniteNumber(prevSignal)
    ) {
      continue;
    }

    if (prevDss <= prevSignal && dss > signal) {
      events.push(
        createIndicatorEvent(DSS_EVENT_DEFINITIONS.BULLISH_CROSS, {
          candle: candles[i],
          index: i,
          payload: {
            dss,
            signal,
            direction: 'bullish',
          },
        }),
      );
    } else if (prevDss >= prevSignal && dss < signal) {
      events.push(
        createIndicatorEvent(DSS_EVENT_DEFINITIONS.BEARISH_CROSS, {
          candle: candles[i],
          index: i,
          payload: {
            dss,
            signal,
            direction: 'bearish',
          },
        }),
      );
    }

    if (prevDss <= OVERBOUGHT_LEVEL && dss > OVERBOUGHT_LEVEL) {
      events.push(
        createIndicatorEvent(DSS_EVENT_DEFINITIONS.ENTER_OVERBOUGHT, {
          candle: candles[i],
          index: i,
          payload: {
            dss,
            threshold: OVERBOUGHT_LEVEL,
            state: 'overbought',
          },
        }),
      );
    }

    if (prevDss >= OVERSOLD_LEVEL && dss < OVERSOLD_LEVEL) {
      events.push(
        createIndicatorEvent(DSS_EVENT_DEFINITIONS.ENTER_OVERSOLD, {
          candle: candles[i],
          index: i,
          payload: {
            dss,
            threshold: OVERSOLD_LEVEL,
            state: 'oversold',
          },
        }),
      );
    }
  }

  return events;
};
