import type { Candle, IndicatorEvent, LinePoint } from '../../types';
import { ema as computeEmaArray } from '../../math/ema';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { toLinePoints } from '../../utils/series';
import { createIndicatorEvent } from '../../utils/events';
import { extractSeries, type MovingAverageSource } from './common';

export type EmaCloudParams = {
  lengths?: number[];
  source?: MovingAverageSource;
  alignmentConfirmation?: number;
};

export type ResolvedEmaCloudParams = {
  lengths: number[];
  source: MovingAverageSource;
  alignmentConfirmation: number;
};

export type EmaCloudLine = {
  length: number;
  points: LinePoint[];
};

export type EmaCloudResult = {
  lines: EmaCloudLine[];
  params: ResolvedEmaCloudParams;
};

export type EmaCloudSnapshot = {
  length: number;
  value: number;
};

export type EmaAlignmentEventPayload = {
  alignmentType: 'bullish' | 'bearish' | 'bullish_unaligned' | 'bearish_unaligned';
  values: EmaCloudSnapshot[];
};

export type EmaCloudHitPayload = {
  cloudType: 'bullish' | 'bearish';
  values: EmaCloudSnapshot[];
  high: number;
  low: number;
};

export type EmaAlignmentDurationPayload = {
  alignmentType: 'bullish' | 'bearish';
  values: EmaCloudSnapshot[];
  streak: number;
  threshold: number;
};

const DEFAULT_LENGTHS = [10, 20, 50, 200];
const DEFAULT_ALIGNMENT_CONFIRMATION = 10;

const EMA_CLOUD_EVENT_DEFINITIONS = {
  BULLISH_ALIGNMENT: {
    id: 'ema_bullish_alignment',
    name: 'Bullish EMA Alignment',
    description: 'EMA(10) > EMA(20) > EMA(50) > EMA(200).',
  },
  BULLISH_UNALIGNMENT: {
    id: 'ema_bullish_unalignment',
    name: 'Bullish EMA Unalignment',
    description: 'The bullish EMA stack lost alignment.',
  },
  BEARISH_ALIGNMENT: {
    id: 'ema_bearish_alignment',
    name: 'Bearish EMA Alignment',
    description: 'EMA(10) < EMA(20) < EMA(50) < EMA(200).',
  },
  BEARISH_UNALIGNMENT: {
    id: 'ema_bearish_unalignment',
    name: 'Bearish EMA Unalignment',
    description: 'The bearish EMA stack lost alignment.',
  },
  BULLISH_CLOUD_HIT: {
    id: 'ema_bullish_cloud_hit',
    name: 'Bullish EMA Cloud Hit',
    description: 'Price pulled back into the bull EMA cloud (low pierced EMA10).',
  },
  BEARISH_CLOUD_HIT: {
    id: 'ema_bearish_cloud_hit',
    name: 'Bearish EMA Cloud Hit',
    description: 'Price rallied into the bear EMA cloud (high pierced EMA10).',
  },
  BULLISH_ALIGNMENT_SUSTAINED: {
    id: 'ema_bullish_alignment_sustained',
    name: 'Bullish EMA Alignment Sustained',
    description: 'Bullish EMA alignment persisted for the configured duration.',
  },
  BEARISH_ALIGNMENT_SUSTAINED: {
    id: 'ema_bearish_alignment_sustained',
    name: 'Bearish EMA Alignment Sustained',
    description: 'Bearish EMA alignment persisted for the configured duration.',
  },
} as const;

const isMonotonically = (
  snapshots: EmaCloudSnapshot[],
  comparator: (a: number, b: number) => boolean,
): boolean => snapshots.every((entry, index) => {
  if (index === 0) {
    return true;
  }
  const previous = snapshots[index - 1];
  return comparator(previous.value, entry.value);
});

const toSnapshotRecord = (lengths: number[], stacks: Map<number, Array<number | undefined>>, index: number) => {
  const snapshots: EmaCloudSnapshot[] = [];

  for (const length of lengths) {
    const value = stacks.get(length)?.[index];
    if (!isFiniteNumber(value)) {
      return null;
    }
    snapshots.push({ length, value });
  }

  return snapshots;
};

const buildEmaStacks = (series: Array<number | undefined>, lengths: number[]): Map<number, Array<number | undefined>> => {
  const stacks = new Map<number, Array<number | undefined>>();
  lengths.forEach((length) => {
    stacks.set(length, computeEmaArray(series, length));
  });
  return stacks;
};

const normalizeLengths = (lengths: number[]): number[] => {
  if (lengths.length < 2) {
    throw new TypeError('lengths must include at least two entries');
  }

  const uniqueSorted = Array.from(new Set(lengths)).sort((a, b) => a - b);

  uniqueSorted.forEach((length) => {
    assertPositiveInteger(length, 'lengths');
  });

  return uniqueSorted;
};

export const resolveEmaCloudParams = (params: EmaCloudParams = {}): ResolvedEmaCloudParams => {
  const resolvedLengths = normalizeLengths(params.lengths ?? DEFAULT_LENGTHS);
  const alignmentConfirmation = params.alignmentConfirmation ?? DEFAULT_ALIGNMENT_CONFIRMATION;
  assertPositiveInteger(alignmentConfirmation, 'alignmentConfirmation');

  return {
    lengths: resolvedLengths,
    source: params.source ?? 'close',
    alignmentConfirmation,
  };
};

export const computeEmaCloud = (candles: Candle[], params?: EmaCloudParams): EmaCloudResult => {
  const resolved = resolveEmaCloudParams(params);

  if (candles.length === 0) {
    return {
      lines: [],
      params: resolved,
    };
  }

  const series = extractSeries(candles, resolved.source);
  const stacks = buildEmaStacks(series, resolved.lengths);
  const lines: EmaCloudLine[] = resolved.lengths.map((length) => {
    const values = stacks.get(length) ?? [];
    return {
      length,
      points: toLinePoints(candles, values),
    };
  });

  return { lines, params: resolved };
};

export const getEventDefinitions = () => Object.values(EMA_CLOUD_EVENT_DEFINITIONS);

export const detectEvents = (
  candles: Candle[],
  params?: EmaCloudParams,
): IndicatorEvent<EmaAlignmentEventPayload | EmaCloudHitPayload | EmaAlignmentDurationPayload>[] => {
  if (!candles.length) {
    return [];
  }

  const resolved = resolveEmaCloudParams(params);
  const series = extractSeries(candles, resolved.source);
  const stacks = buildEmaStacks(series, resolved.lengths);
  const startIndex = Math.max(...resolved.lengths);
  const events: IndicatorEvent<
    EmaAlignmentEventPayload | EmaCloudHitPayload | EmaAlignmentDurationPayload
  >[] = [];

  let bullishAlignedActive = false;
  let bearishAlignedActive = false;
  let bullishStreak = 0;
  let bearishStreak = 0;
  let bullishSustainedEmitted = false;
  let bearishSustainedEmitted = false;

  for (let i = startIndex; i < candles.length; i += 1) {
    const snapshots = toSnapshotRecord(resolved.lengths, stacks, i);
    if (!snapshots) {
      continue;
    }

    const bullishAligned = isMonotonically(snapshots, (a, b) => a > b);
    const bearishAligned = isMonotonically(snapshots, (a, b) => a < b);

    bullishStreak = bullishAligned ? bullishStreak + 1 : 0;
    bearishStreak = bearishAligned ? bearishStreak + 1 : 0;

    if (!bullishAligned) {
      bullishSustainedEmitted = false;
    }
    if (!bearishAligned) {
      bearishSustainedEmitted = false;
    }

    if (bullishAligned && !bullishAlignedActive) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BULLISH_ALIGNMENT, {
          candle: candles[i],
          index: i,
          payload: {
            alignmentType: 'bullish',
            values: snapshots,
          },
        }),
      );
      bullishAlignedActive = true;
    }

    if (!bullishAligned && bullishAlignedActive) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BULLISH_UNALIGNMENT, {
          candle: candles[i],
          index: i,
          payload: {
            alignmentType: 'bullish_unaligned',
            values: snapshots,
          },
        }),
      );
      bullishAlignedActive = false;
    }

    if (
      bullishAligned &&
      !bullishSustainedEmitted &&
      bullishStreak >= resolved.alignmentConfirmation
    ) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BULLISH_ALIGNMENT_SUSTAINED, {
          candle: candles[i],
          index: i,
          payload: {
            alignmentType: 'bullish',
            values: snapshots,
            streak: bullishStreak,
            threshold: resolved.alignmentConfirmation,
          },
        }),
      );
      bullishSustainedEmitted = true;
    }

    if (bearishAligned && !bearishAlignedActive) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BEARISH_ALIGNMENT, {
          candle: candles[i],
          index: i,
          payload: {
            alignmentType: 'bearish',
            values: snapshots,
          },
        }),
      );
      bearishAlignedActive = true;
    }

    if (!bearishAligned && bearishAlignedActive) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BEARISH_UNALIGNMENT, {
          candle: candles[i],
          index: i,
          payload: {
            alignmentType: 'bearish_unaligned',
            values: snapshots,
          },
        }),
      );
      bearishAlignedActive = false;
    }

    if (
      bearishAligned &&
      !bearishSustainedEmitted &&
      bearishStreak >= resolved.alignmentConfirmation
    ) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BEARISH_ALIGNMENT_SUSTAINED, {
          candle: candles[i],
          index: i,
          payload: {
            alignmentType: 'bearish',
            values: snapshots,
            streak: bearishStreak,
            threshold: resolved.alignmentConfirmation,
          },
        }),
      );
      bearishSustainedEmitted = true;
    }

    const fastestEma = snapshots[0]?.value;
    const previousCandle = candles[i - 1];
    const currentCandle = candles[i];

    if (
      bullishAligned &&
      isFiniteNumber(fastestEma) &&
      previousCandle.l > fastestEma &&
      currentCandle.l < fastestEma
    ) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BULLISH_CLOUD_HIT, {
          candle: currentCandle,
          index: i,
          payload: {
            cloudType: 'bullish',
            values: snapshots,
            high: currentCandle.h,
            low: currentCandle.l,
          },
        }),
      );
    }

    if (
      bearishAligned &&
      isFiniteNumber(fastestEma) &&
      previousCandle.h < fastestEma &&
      currentCandle.h > fastestEma
    ) {
      events.push(
        createIndicatorEvent(EMA_CLOUD_EVENT_DEFINITIONS.BEARISH_CLOUD_HIT, {
          candle: currentCandle,
          index: i,
          payload: {
            cloudType: 'bearish',
            values: snapshots,
            high: currentCandle.h,
            low: currentCandle.l,
          },
        }),
      );
    }
  }

  return events;
};
