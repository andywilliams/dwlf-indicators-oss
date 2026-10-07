import type { Candle, IndicatorEvent } from '../../types';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { createIndicatorEvent } from '../../utils/events';
import { findFirstBreakAfterSwing } from './swingBreak';
import { findFirstSweepAfterSwing } from './swingSweep';

export type SwingParams = {
  lookback?: number;
  sweepBars?: number;
};

export type ResolvedSwingParams = Required<SwingParams>;

const DEFAULT_PARAMS: ResolvedSwingParams = {
  lookback: 3,
  sweepBars: 1,
};

const SWING_EVENT_DEFINITIONS = {
  SWING_HIGH_FORMED: {
    id: 'swing_high_formed',
    name: 'Swing High Formed',
    description: 'A swing high was confirmed: stamped on the bar `lookback` bars after the pivot, when it became knowable.',
  },
  SWING_LOW_FORMED: {
    id: 'swing_low_formed',
    name: 'Swing Low Formed',
    description: 'A swing low was confirmed: stamped on the bar `lookback` bars after the pivot, when it became knowable.',
  },
  HIGHER_HIGH: {
    id: 'higher_high',
    name: 'Higher High',
    description: 'The latest swing high exceeds the previous swing high: stamped on the bar `lookback` bars after the latest pivot, when it became knowable (the pivot is payload.pivotIndex).',
  },
  LOWER_HIGH: {
    id: 'lower_high',
    name: 'Lower High',
    description: 'The latest swing high is below the previous swing high: stamped on the bar `lookback` bars after the latest pivot, when it became knowable (the pivot is payload.pivotIndex).',
  },
  HIGHER_LOW: {
    id: 'higher_low',
    name: 'Higher Low',
    description: 'The latest swing low exceeds the previous swing low: stamped on the bar `lookback` bars after the latest pivot, when it became knowable (the pivot is payload.pivotIndex).',
  },
  LOWER_LOW: {
    id: 'lower_low',
    name: 'Lower Low',
    description: 'The latest swing low is below the previous swing low: stamped on the bar `lookback` bars after the latest pivot, when it became knowable (the pivot is payload.pivotIndex).',
  },
  SWING_HIGH_BREAK: {
    id: 'swing_high_break',
    name: 'Swing High Break',
    description: 'Price broke above a prior swing high.',
  },
  SWING_LOW_BREAK: {
    id: 'swing_low_break',
    name: 'Swing Low Break',
    description: 'Price broke below a prior swing low.',
  },
  SWING_HIGH_SWEEP: {
    id: 'swing_high_sweep',
    name: 'Swing High Sweep',
    description: 'Price swept above a prior swing high and quickly reclaimed below it.',
  },
  SWING_LOW_SWEEP: {
    id: 'swing_low_sweep',
    name: 'Swing Low Sweep',
    description: 'Price swept below a prior swing low and quickly reclaimed above it.',
  },
} as const;

export const resolveSwingParams = (params: SwingParams = {}): ResolvedSwingParams => {
  const resolved: ResolvedSwingParams = {
    lookback: params.lookback ?? DEFAULT_PARAMS.lookback,
    sweepBars: params.sweepBars ?? DEFAULT_PARAMS.sweepBars,
  };

  assertPositiveInteger(resolved.lookback, 'lookback');
  assertPositiveInteger(resolved.sweepBars, 'sweepBars');

  return resolved;
};

type SwingPointBase = {
  index: number;
  price: number;
  t: number;
  candle: Candle;
};

export type SwingHigh = SwingPointBase & { type: 'high' };
export type SwingLow = SwingPointBase & { type: 'low' };

export type SwingsResult = {
  highs: SwingHigh[];
  lows: SwingLow[];
  points: Array<SwingHigh | SwingLow>;
  params: ResolvedSwingParams;
};

// A swing is a pivot bar, but it is only knowable once `lookback` bars have
// closed to its right. Formed and comparison events are stamped at that
// knowable bar (`index`, `t`, `candle`); the pivot itself rides the payload.
type SwingPivotFields = {
  pivotIndex: number;
  pivotTime: number;
};

type SwingFormedPayload = SwingPivotFields & {
  variant: 'swing_high_formed' | 'swing_low_formed';
  price: number;
  swingType: 'high' | 'low';
  lookback: number;
};

type SwingComparisonPayload = SwingPivotFields & {
  variant: 'higher_high' | 'lower_high' | 'higher_low' | 'lower_low';
  swingType: 'high' | 'low';
  currentPrice: number;
  previousPrice: number;
  previousPivotIndex: number;
  previousPivotTime: number;
};

type SwingBreakPayload = {
  variant: 'swing_high_break' | 'swing_low_break';
  swingType: 'high' | 'low';
  swingPrice: number;
  breakPrice: number;
  previousPrice: number;
};

type SwingSweepPayload = {
  variant: 'swing_high_sweep' | 'swing_low_sweep';
  swingType: 'high' | 'low';
  swingPrice: number;
  sweepPrice: number;
  reclaimPrice: number;
  sweepIndex: number;
  reclaimIndex: number;
  barsToReclaim: number;
};

export type SwingEventPayload =
  | SwingFormedPayload
  | SwingComparisonPayload
  | SwingBreakPayload
  | SwingSweepPayload;

const collectWindowValues = (
  candles: Candle[],
  start: number,
  end: number,
  selector: (candle: Candle) => number,
): number[] => {
  const values: number[] = [];
  for (let i = start; i < end; i += 1) {
    const value = selector(candles[i]);
    if (isFiniteNumber(value)) {
      values.push(value);
    }
  }
  return values;
};

export const computeSwings = (candles: Candle[], params?: SwingParams): SwingsResult => {
  const resolved = resolveSwingParams(params);

  if (candles.length === 0) {
    return {
      highs: [],
      lows: [],
      points: [],
      params: resolved,
    };
  }

  const { lookback } = resolved;
  const highs: SwingHigh[] = [];
  const lows: SwingLow[] = [];

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const candle = candles[i];
    const currentHigh = candle.h;
    const currentLow = candle.l;

    if (!isFiniteNumber(currentHigh) || !isFiniteNumber(currentLow)) {
      continue;
    }

    const prevHighs = collectWindowValues(candles, i - lookback, i, (entry) => entry.h);
    const nextHighs = collectWindowValues(candles, i + 1, i + 1 + lookback, (entry) => entry.h);
    const prevLows = collectWindowValues(candles, i - lookback, i, (entry) => entry.l);
    const nextLows = collectWindowValues(candles, i + 1, i + 1 + lookback, (entry) => entry.l);

    if (
      prevHighs.length === lookback &&
      nextHighs.length === lookback &&
      currentHigh > Math.max(...prevHighs) &&
      currentHigh >= Math.max(...nextHighs)
    ) {
      highs.push({
        index: i,
        price: currentHigh,
        t: candle.t,
        candle,
        type: 'high',
      });
    }

    if (
      prevLows.length === lookback &&
      nextLows.length === lookback &&
      currentLow < Math.min(...prevLows) &&
      currentLow <= Math.min(...nextLows)
    ) {
      lows.push({
        index: i,
        price: currentLow,
        t: candle.t,
        candle,
        type: 'low',
      });
    }
  }

  const points = [...highs, ...lows].sort((a, b) => a.index - b.index);

  return {
    highs,
    lows,
    points,
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(SWING_EVENT_DEFINITIONS);

export const detectEvents = (
  candles: Candle[],
  params?: SwingParams,
): IndicatorEvent<SwingEventPayload>[] => {
  if (!candles.length) {
    return [];
  }
  const result = computeSwings(candles, params);
  const events: IndicatorEvent<SwingEventPayload>[] = [];

  // The bar a pivot becomes knowable on: `lookback` bars to its right have
  // closed. computeSwings only returns pivots with that many bars after them.
  const knowableAt = (point: SwingHigh | SwingLow) => {
    const index = point.index + result.params.lookback;
    return { index, candle: candles[index] };
  };

  const addFormedEvent = (point: SwingHigh | SwingLow) => {
    const isHigh = point.type === 'high';
    const definition = isHigh
      ? SWING_EVENT_DEFINITIONS.SWING_HIGH_FORMED
      : SWING_EVENT_DEFINITIONS.SWING_LOW_FORMED;
    const variant: SwingFormedPayload['variant'] = isHigh ? 'swing_high_formed' : 'swing_low_formed';

    events.push(
      createIndicatorEvent(definition, {
        ...knowableAt(point),
        payload: {
          variant,
          price: point.price,
          swingType: point.type,
          lookback: result.params.lookback,
          pivotIndex: point.index,
          pivotTime: point.t,
        },
      }),
    );
  };

  result.highs.forEach(addFormedEvent);
  result.lows.forEach(addFormedEvent);

  for (let i = 1; i < result.highs.length; i += 1) {
    const previous = result.highs[i - 1];
    const current = result.highs[i];
    let definition;
    let variant: SwingComparisonPayload['variant'] | null = null;
    if (current.price > previous.price) {
      definition = SWING_EVENT_DEFINITIONS.HIGHER_HIGH;
      variant = 'higher_high';
    } else if (current.price < previous.price) {
      definition = SWING_EVENT_DEFINITIONS.LOWER_HIGH;
      variant = 'lower_high';
    }

    if (variant && definition) {
      events.push(
        createIndicatorEvent(definition, {
          ...knowableAt(current),
          payload: {
            variant,
            swingType: 'high',
            currentPrice: current.price,
            previousPrice: previous.price,
            pivotIndex: current.index,
            pivotTime: current.t,
            previousPivotIndex: previous.index,
            previousPivotTime: previous.t,
          },
        }),
      );
    }
  }

  for (let i = 1; i < result.lows.length; i += 1) {
    const previous = result.lows[i - 1];
    const current = result.lows[i];
    let definition;
    let variant: SwingComparisonPayload['variant'] | null = null;
    if (current.price > previous.price) {
      definition = SWING_EVENT_DEFINITIONS.HIGHER_LOW;
      variant = 'higher_low';
    } else if (current.price < previous.price) {
      definition = SWING_EVENT_DEFINITIONS.LOWER_LOW;
      variant = 'lower_low';
    }

    if (variant && definition) {
      events.push(
        createIndicatorEvent(definition, {
          ...knowableAt(current),
          payload: {
            variant,
            swingType: 'low',
            currentPrice: current.price,
            previousPrice: previous.price,
            pivotIndex: current.index,
            pivotTime: current.t,
            previousPivotIndex: previous.index,
            previousPivotTime: previous.t,
          },
        }),
      );
    }
  }

  const addBreakEvent = (
    point: SwingHigh | SwingLow,
    nextSameTypeIndex: number | null,
  ) => {
    // Only look for breaks until the next swing of the same type, so we reference
    // the most recent swing high/low at the time of the break.
    const resultBreak = findFirstBreakAfterSwing(candles, point, nextSameTypeIndex ?? undefined);
    if (!resultBreak) {
      return;
    }

    const isHigh = point.type === 'high';
    const definition = isHigh
      ? SWING_EVENT_DEFINITIONS.SWING_HIGH_BREAK
      : SWING_EVENT_DEFINITIONS.SWING_LOW_BREAK;
    const variant: SwingBreakPayload['variant'] = isHigh ? 'swing_high_break' : 'swing_low_break';
    const breakPrice = isHigh ? resultBreak.breakCandle.h : resultBreak.breakCandle.l;
    const previousPrice = isHigh ? resultBreak.previousCandle.h : resultBreak.previousCandle.l;

    events.push(
      createIndicatorEvent(definition, {
        candle: resultBreak.breakCandle,
        index: resultBreak.breakIndex,
        payload: {
          variant,
          swingType: point.type,
          swingPrice: point.price,
          breakPrice,
          previousPrice,
        },
      }),
    );
  };

  // Look for breaks of the most recent swing high/low only (between swings of the same type)
  result.highs.forEach((point, idx) => {
    const next = result.highs[idx + 1];
    // include the next swing candle so a new swing that exceeds the prior one counts as the break
    addBreakEvent(point, next ? next.index + result.params.lookback + 1 : null);
  });

  result.lows.forEach((point, idx) => {
    const next = result.lows[idx + 1];
    addBreakEvent(point, next ? next.index + result.params.lookback + 1 : null);
  });

  const addSweepEvent = (
    point: SwingHigh | SwingLow,
    nextSameTypeIndex: number | null,
  ) => {
    const resultSweep = findFirstSweepAfterSwing(
      candles,
      point,
      result.params.sweepBars,
      nextSameTypeIndex ?? undefined,
    );
    if (!resultSweep) {
      return;
    }

    const isHigh = point.type === 'high';
    const definition = isHigh
      ? SWING_EVENT_DEFINITIONS.SWING_HIGH_SWEEP
      : SWING_EVENT_DEFINITIONS.SWING_LOW_SWEEP;
    const variant: SwingSweepPayload['variant'] = isHigh
      ? 'swing_high_sweep'
      : 'swing_low_sweep';

    events.push(
      createIndicatorEvent(definition, {
        candle: resultSweep.reclaimCandle,
        index: resultSweep.reclaimIndex,
        payload: {
          variant,
          swingType: point.type,
          swingPrice: point.price,
          sweepPrice: resultSweep.sweepPrice,
          reclaimPrice: resultSweep.reclaimPrice,
          sweepIndex: resultSweep.sweepIndex,
          reclaimIndex: resultSweep.reclaimIndex,
          barsToReclaim: resultSweep.barsToReclaim,
        },
      }),
    );
  };

  if (result.params.sweepBars > 0) {
    // A swing stays the one being swept until the next swing of its type is
    // KNOWABLE (its pivot + lookback), not from its pivot bar: until then a
    // live run cannot know it exists. (Breaks need no such window: a bar after
    // the next pivot cannot cross a level the pivot itself did not.)
    const sweepEnd = (next: SwingHigh | SwingLow | undefined) => (
      next ? next.index + result.params.lookback + 1 : null
    );
    result.highs.forEach((point, idx) => {
      addSweepEvent(point, sweepEnd(result.highs[idx + 1]));
    });

    result.lows.forEach((point, idx) => {
      addSweepEvent(point, sweepEnd(result.lows[idx + 1]));
    });
  }

  return events;
};
