import type { Candle, IndicatorEvent } from '../../types';
import { computeSwings } from '../swing/swing';
import { createIndicatorEvent } from '../../utils/events';

const DEFAULT_SWING_LOOKBACK = 5;
const BASE_RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const DEFAULT_EXTENSION_RATIOS = [1.272, 1.618];

const FIB_EVENT_DEFINITIONS = {
  IMPULSE_DETECTED: {
    id: 'fib.impulse.detected',
    name: 'Fib Impulse Detected',
    description: 'A qualifying swing impulse was identified in the weekly candle set.',
  },
} as const;

export type FibCandle = Candle & {
  date?: string;
  weekStartDate?: string;
  datetime?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  Open?: number;
  High?: number;
  Low?: number;
  Close?: number;
};

export type NormalisedCandle = {
  index: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type FibImpulse = {
  direction: 'bullish' | 'bearish';
  startIndex: number;
  endIndex: number;
  startDate: string;
  endDate: string;
  startPrice: number;
  endPrice: number;
  amplitudePct: number;
  durationWeeks: number;
};

export type FibLevel = {
  label: string;
  price: number;
};

export type FibLevelSet = {
  symbol?: string;
  basis?: string;
  source?: string;
  isActive: boolean;
  impulseDirection: FibImpulse['direction'];
  impulseStart: string;
  impulseEnd: string;
  impulseStartPrice: number;
  impulseEndPrice: number;
  impulseDurationWeeks: number;
  impulseAmplitudePct: number;
  breakoutExtensionPct?: number;
  swingLookback?: number;
  levels: FibLevel[];
  createdAt?: string;
  updatedAt?: string;
};

export type DetectImpulsesOptions = {
  minMovePct?: number;
  minDurationWeeks?: number;
  swingLookback?: number;
};

export type BuildFibSetOptions = {
  breakoutExtensionPct?: number;
  swingLookback?: number;
  basis?: string;
  source?: string;
};

export type EvaluateBreakoutOptions = {
  breakoutExtensionPctOverride?: number;
};

const toPercent = (startPrice: number, endPrice: number): number =>
  ((endPrice - startPrice) / startPrice) * 100;

const toIsoDate = (candle: FibCandle): string | undefined => {
  if (candle.date) {
    return candle.date;
  }
  if (candle.weekStartDate) {
    return candle.weekStartDate;
  }
  if (Number.isFinite(candle.t)) {
    const iso = new Date(candle.t).toISOString();
    return iso;
  }
  if (candle.datetime) {
    return candle.datetime;
  }
  return undefined;
};

export const normaliseCandles = (candles: FibCandle[] = []): NormalisedCandle[] =>
  candles
    .map((candle, index) => {
      if (!candle) {
        return null;
      }
      const date = toIsoDate(candle);
      if (!date) {
        return null;
      }
      const open = Number(candle.o ?? candle.open ?? candle.Open);
      const high = Number(candle.h ?? candle.high ?? candle.High);
      const low = Number(candle.l ?? candle.low ?? candle.Low);
      const close = Number(candle.c ?? candle.close ?? candle.Close);
      if ([open, high, low, close].some((value) => !Number.isFinite(value))) {
        return null;
      }
      return {
        index,
        date,
        open,
        high,
        low,
        close,
      };
    })
    .filter((candle): candle is NormalisedCandle => Boolean(candle));

const mergeSwings = (candles: NormalisedCandle[], lookback: number) => {
  const swingCandles: Candle[] = candles.map((candle) => ({
    t: new Date(candle.date).getTime(),
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
  }));

  const swings = computeSwings(swingCandles, { lookback });
  const points = [
    ...swings.highs.map((point) => ({ ...point, type: 'high' as const })),
    ...swings.lows.map((point) => ({ ...point, type: 'low' as const })),
  ];

  const ordered = points.sort((a, b) => a.index - b.index);
  const merged: typeof ordered = [];

  ordered.forEach((point) => {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(point);
      return;
    }

    if (point.type === last.type) {
      if (point.type === 'high') {
        if (point.price >= last.price) {
          merged[merged.length - 1] = point;
        }
      } else if (point.price <= last.price) {
        merged[merged.length - 1] = point;
      }
      return;
    }

    merged.push(point);
  });

  return merged.map((point) => ({
    ...point,
    date: candles[point.index]?.date,
  }));
};

const calculateImpulse = (start: ReturnType<typeof mergeSwings>[number], end: ReturnType<typeof mergeSwings>[number]): FibImpulse | null => {
  const durationWeeks = end.index - start.index;
  const startDate = start.date;
  const endDate = end.date;
  if (durationWeeks <= 0 || !startDate || !endDate) {
    return null;
  }

  const makeImpulse = (direction: 'bullish' | 'bearish'): FibImpulse => ({
    direction,
    startIndex: start.index,
    endIndex: end.index,
    startDate,
    endDate,
    startPrice: start.price,
    endPrice: end.price,
    amplitudePct: toPercent(start.price, end.price) * (direction === 'bearish' ? -1 : 1),
    durationWeeks,
  });

  if (start.type === 'low' && end.type === 'high') {
    return makeImpulse('bullish');
  }
  if (start.type === 'high' && end.type === 'low') {
    return makeImpulse('bearish');
  }
  return null;
};

export const detectWeeklyImpulses = (
  rawCandles: FibCandle[],
  options: DetectImpulsesOptions = {},
): FibImpulse[] => {
  const {
    minMovePct = 0,
    minDurationWeeks = 1,
    swingLookback = DEFAULT_SWING_LOOKBACK,
  } = options;

  const candles = normaliseCandles(rawCandles);
  if (candles.length < swingLookback * 2 + 1) {
    return [];
  }

  const swings = mergeSwings(candles, swingLookback);
  if (swings.length < 2) {
    return [];
  }

  const impulses: FibImpulse[] = [];
  for (let i = 0; i < swings.length - 1; i += 1) {
    const impulse = calculateImpulse(swings[i], swings[i + 1]);
    if (
      impulse &&
      Math.abs(impulse.amplitudePct) >= minMovePct &&
      impulse.durationWeeks >= minDurationWeeks
    ) {
      impulses.push({
        ...impulse,
        amplitudePct: Number(impulse.amplitudePct.toFixed(2)),
      });
    }
  }

  return impulses;
};

const toRatio = (percent?: number | string): number | null => {
  if (percent === undefined || percent === null) {
    return null;
  }
  const numeric = typeof percent === 'number' ? percent : Number(percent);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric / 100;
};

const formatPercentLabel = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const roundPrice = (price: number): number => Number(price.toFixed(4));

export const calculateFibLevels = (
  impulse: FibImpulse | null,
  { breakoutExtensionPct }: { breakoutExtensionPct?: number } = {},
): FibLevel[] => {
  if (!impulse) {
    return [];
  }

  const { direction, startPrice, endPrice } = impulse;
  const diff = direction === 'bullish' ? endPrice - startPrice : startPrice - endPrice;
  if (diff === 0) {
    return [];
  }

  const extensionRatios = new Set(DEFAULT_EXTENSION_RATIOS);
  const breakoutRatio = toRatio(breakoutExtensionPct);
  if (breakoutRatio && breakoutRatio > 1) {
    extensionRatios.add(Number(breakoutRatio.toFixed(3)));
  }

  const ratios = [
    ...BASE_RETRACEMENT_RATIOS,
    ...Array.from(extensionRatios).sort((a, b) => a - b),
  ];

  return ratios.map((ratio) => {
    const price = direction === 'bullish'
      ? startPrice + diff * ratio
      : startPrice - diff * ratio;
    return {
      label: formatPercentLabel(ratio),
      price: roundPrice(price),
    };
  });
};

export const buildFibLevelSet = (
  symbol: string,
  impulse: FibImpulse | null,
  options: BuildFibSetOptions = {},
): FibLevelSet | null => {
  if (!impulse) {
    return null;
  }

  const levels = calculateFibLevels(impulse, options);
  const now = new Date().toISOString();

  return {
    symbol,
    basis: options.basis ?? 'weekly_impulse',
    source: options.source ?? 'auto_weekly_detection',
    isActive: true,
    impulseDirection: impulse.direction,
    impulseStart: impulse.startDate,
    impulseEnd: impulse.endDate,
    impulseStartPrice: Number(impulse.startPrice.toFixed(4)),
    impulseEndPrice: Number(impulse.endPrice.toFixed(4)),
    impulseDurationWeeks: impulse.durationWeeks,
    impulseAmplitudePct: Number(Math.abs(impulse.amplitudePct).toFixed(2)),
    breakoutExtensionPct: options.breakoutExtensionPct,
    swingLookback: options.swingLookback ?? DEFAULT_SWING_LOOKBACK,
    levels,
    createdAt: now,
    updatedAt: now,
  };
};

const findBreakoutLevelPrice = (levels: FibLevel[], breakoutPct?: number): number | null => {
  if (!Number.isFinite(breakoutPct)) {
    return null;
  }
  const label = `${Number(breakoutPct).toFixed(1)}%`;
  const level = levels.find((entry) => entry.label === label);
  return level ? Number(level.price) : null;
};

export const evaluateBreakout = (
  fibSet: FibLevelSet | null,
  candles: FibCandle[],
  options: EvaluateBreakoutOptions = {},
) => {
  if (!fibSet || !fibSet.isActive) {
    return { breached: false };
  }

  const breakoutPct = Number(options.breakoutExtensionPctOverride ?? fibSet.breakoutExtensionPct);
  const breakoutPrice = findBreakoutLevelPrice(fibSet.levels || [], breakoutPct);
  if (breakoutPrice === null || !Number.isFinite(breakoutPrice)) {
    return { breached: false };
  }

  const normalised = normaliseCandles(candles);
  if (!normalised.length) {
    return { breached: false };
  }

  const relevant = fibSet.impulseEnd
    ? normalised.filter((candle) => candle.date >= fibSet.impulseEnd)
    : normalised;

  for (const candle of relevant) {
    const high = Number(candle.high);
    const low = Number(candle.low);

    if (
      fibSet.impulseDirection === 'bullish' &&
      Number.isFinite(high) &&
      high >= breakoutPrice
    ) {
      return {
        breached: true,
        breachDate: candle.date,
        breachPrice: high,
        breakoutPrice,
      };
    }

    if (
      fibSet.impulseDirection === 'bearish' &&
      Number.isFinite(low) &&
      low <= breakoutPrice
    ) {
      return {
        breached: true,
        breachDate: candle.date,
        breachPrice: low,
        breakoutPrice,
      };
    }
  }

  return { breached: false };
};

export const FIB_DEFAULTS = {
  swingLookback: DEFAULT_SWING_LOOKBACK,
  retracementRatios: BASE_RETRACEMENT_RATIOS,
  extensionRatios: DEFAULT_EXTENSION_RATIOS,
};

const parseTimestamp = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

export const getEventDefinitions = () => Object.values(FIB_EVENT_DEFINITIONS);

export const detectEvents = (
  rawCandles: FibCandle[],
  options?: DetectImpulsesOptions,
): IndicatorEvent<FibImpulse>[] => {
  const impulses = detectWeeklyImpulses(rawCandles, options);
  return impulses.map((impulse) =>
    createIndicatorEvent(FIB_EVENT_DEFINITIONS.IMPULSE_DETECTED, {
      index: impulse.endIndex,
      t: parseTimestamp(impulse.endDate),
      payload: impulse,
    }),
  );
};
