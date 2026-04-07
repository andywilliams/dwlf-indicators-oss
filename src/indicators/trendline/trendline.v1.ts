import type { Candle, IndicatorEvent } from '../../types';
import { computeSwings } from '../swing/swing';
import { evaluateTrendlineBreaches } from './breachDetection';
import { isSlopeDirectionCompatible } from './slopeGuards';
import type { TrendlineBreachEventPayloadBase } from './trendline';
import { createIndicatorEvent } from '../../utils/events';

type SwingPoint = ReturnType<typeof computeSwings>['points'][number];
type SwingLow = ReturnType<typeof computeSwings>['lows'][number];
type SwingHigh = ReturnType<typeof computeSwings>['highs'][number];

export type TrendlineV1Params = {
  swingLookback?: number;
};

export type ResolvedTrendlineV1Params = Required<TrendlineV1Params>;

export type TrendlineV1Point = {
  index: number;
  price: number;
  date?: string;
};

export type TrendlineV1 = {
  start: TrendlineV1Point;
  end: TrendlineV1Point;
  anchor: TrendlineV1Point;
  startIndex: number;
  endIndex: number;
  anchorEndIndex: number;
  anchorEndPrice: number;
  slope: number;
  intercept: number;
  isActive: boolean;
  type: 'support' | 'resistance';
};

const DEFAULT_PARAMS: ResolvedTrendlineV1Params = {
  swingLookback: 5,
};

const TRENDLINE_V1_EVENT_DEFINITIONS = {
  BREACH_BULLISH: {
    id: 'trendline_breach_bullish',
    name: 'Trendline Breach (Bullish, v1)',
    description: 'Price wicked through a v1 resistance trendline, signalling a bullish break.',
  },
  BREACH_BEARISH: {
    id: 'trendline_breach_bearish',
    name: 'Trendline Breach (Bearish, v1)',
    description: 'Price wicked through a v1 support trendline, signalling a bearish break.',
  },
  BREAK_BULLISH: {
    id: 'trendline_break_bullish',
    name: 'Trendline Break (Bullish Close, v1)',
    description: 'The candle close moved beyond a v1 resistance trendline.',
  },
  BREAK_BEARISH: {
    id: 'trendline_break_bearish',
    name: 'Trendline Break (Bearish Close, v1)',
    description: 'The candle close moved below a v1 support trendline.',
  },
} as const;

const getTrendlineV1Definition = (
  breakType: 'support_break' | 'resistance_break',
  variant: 'intraday' | 'close',
) => {
  const isBullish = breakType === 'resistance_break';
  if (variant === 'intraday') {
    return isBullish
      ? TRENDLINE_V1_EVENT_DEFINITIONS.BREACH_BULLISH
      : TRENDLINE_V1_EVENT_DEFINITIONS.BREACH_BEARISH;
  }

  return isBullish
    ? TRENDLINE_V1_EVENT_DEFINITIONS.BREAK_BULLISH
    : TRENDLINE_V1_EVENT_DEFINITIONS.BREAK_BEARISH;
};

const resolveParams = (params: TrendlineV1Params = {}): ResolvedTrendlineV1Params => ({
  swingLookback: params.swingLookback ?? DEFAULT_PARAMS.swingLookback,
});

const toIsoDate = (candle: Candle | undefined): string | undefined => {
  if (!candle) {
    return undefined;
  }
  if (typeof candle.t === 'number' && Number.isFinite(candle.t)) {
    const date = new Date(candle.t);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
};

const mapSwingPoint = (point: SwingPoint, candles: Candle[]): TrendlineV1Point => ({
  index: point.index,
  price: point.price,
  date: toIsoDate(candles[point.index]),
});

const groupIncreasing = <T extends SwingPoint>(
  swings: T[],
  comparator: (current: T, previous: T) => boolean,
): T[][] => {
  if (swings.length < 2) {
    return [];
  }

  const groups: T[][] = [];
  let currentGroup: T[] = [swings[0]];

  for (let i = 1; i < swings.length; i += 1) {
    const swing = swings[i];
    const previous = currentGroup[currentGroup.length - 1];

    if (comparator(swing, previous)) {
      currentGroup.push(swing);
      continue;
    }

    if (currentGroup.length > 1) {
      groups.push([...currentGroup]);
    }
    currentGroup = [swing];
  }

  if (currentGroup.length > 1) {
    groups.push([...currentGroup]);
  }

  return groups;
};

const groupUpwardSwingLows = (swingLows: SwingLow[]): SwingLow[][] =>
  groupIncreasing(swingLows, (current, previous) => current.price > previous.price);

const groupDownwardSwingHighs = (swingHighs: SwingHigh[]): SwingHigh[][] =>
  groupIncreasing(swingHighs, (current, previous) => current.price < previous.price);

const computeBestLine = (group: SwingPoint[]) => {
  let bestLine: {
    slope: number;
    intercept: number;
    start: SwingPoint;
    end: SwingPoint;
    error: number;
  } | null = null;

  for (let i = 0; i < group.length - 1; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const start = group[i];
      const end = group[j];
      const slope = (end.price - start.price) / (end.index - start.index);
      const intercept = start.price - slope * start.index;

      let totalSquaredDistance = 0;
      for (const point of group) {
        const yOnLine = slope * point.index + intercept;
        const distance = point.price - yOnLine;
        totalSquaredDistance += distance * distance;
      }

      if (bestLine === null || totalSquaredDistance < bestLine.error) {
        bestLine = {
          slope,
          intercept,
          start,
          end,
          error: totalSquaredDistance,
        };
      }
    }
  }

  return bestLine;
};

const generateTrendlines = (
  groupedPoints: SwingPoint[][],
  candles: Candle[],
  swingPoints: SwingPoint[],
  direction: 'support' | 'resistance',
): TrendlineV1[] => {
  const trendlines: TrendlineV1[] = [];
  if (!groupedPoints.length) {
    return trendlines;
  }

  groupedPoints.forEach((group) => {
    if (group.length < 2) {
      return;
    }

    const bestLine = computeBestLine(group);
    if (!bestLine) {
      return;
    }

    const isSupport = direction === 'support';
    let extendedEndIndex = candles.length - 1;
    let extendedEndPrice = bestLine.slope * extendedEndIndex + bestLine.intercept;

    const futureSwings = swingPoints
      .filter((point) => point.index > bestLine.end.index && point.index <= extendedEndIndex)
      .sort((a, b) => a.index - b.index);

    let trendBroken = false;
    let terminatingSwing: SwingPoint | null = null;

    // Terminate when we see the first structural break in the sequence of swing points:
    // - for support lines: the first LOWER LOW (current low < previous low)
    // - for resistance lines: the first HIGHER HIGH (current high > previous high)
    let lastSwingPrice = bestLine.end.price;

    for (const swing of futureSwings) {
      if (isSupport) {
        if (swing.price < lastSwingPrice) {
          trendBroken = true;
          terminatingSwing = swing;
          break;
        }
      } else {
        if (swing.price > lastSwingPrice) {
          trendBroken = true;
          terminatingSwing = swing;
          break;
        }
      }
      lastSwingPrice = swing.price;
    }

    if (trendBroken && terminatingSwing) {
      extendedEndIndex = terminatingSwing.index;
      extendedEndPrice = bestLine.slope * extendedEndIndex + bestLine.intercept;
    } else if (!trendBroken) {
      extendedEndIndex = candles.length - 1;
      extendedEndPrice = bestLine.slope * extendedEndIndex + bestLine.intercept;
    } else {
      const fallback = swingPoints.find((point) => point.index > bestLine.end.index);
      if (fallback) {
        extendedEndIndex = fallback.index;
        extendedEndPrice = bestLine.slope * fallback.index + bestLine.intercept;
      }
    }

    trendlines.push({
      start: mapSwingPoint(bestLine.start, candles),
      end: {
        index: extendedEndIndex,
        price: extendedEndPrice,
        date: toIsoDate(candles[extendedEndIndex]),
      },
      anchor: mapSwingPoint(bestLine.end, candles),
      startIndex: bestLine.start.index,
      endIndex: extendedEndIndex,
      anchorEndIndex: bestLine.end.index,
      anchorEndPrice: bestLine.end.price,
      slope: bestLine.slope,
      intercept: bestLine.intercept,
      isActive: !trendBroken,
      type: isSupport ? 'support' : 'resistance',
    });
  });

  return trendlines;
};

export type TrendlineV1Result = {
  trendlines: TrendlineV1[];
  params: ResolvedTrendlineV1Params;
};

export const computeTrendlinesV1 = (
  candles: Candle[],
  params?: TrendlineV1Params,
): TrendlineV1Result => {
  const resolved = resolveParams(params);

  if (!candles.length) {
    return { trendlines: [], params: resolved };
  }

  const { highs, lows } = computeSwings(candles, { lookback: resolved.swingLookback });
  const groupedLows = groupUpwardSwingLows(lows);
  const groupedHighs = groupDownwardSwingHighs(highs);

  const supportTrendlines = generateTrendlines(groupedLows, candles, lows, 'support');
  const resistanceTrendlines = generateTrendlines(groupedHighs, candles, highs, 'resistance');

  const trendlines = [...supportTrendlines, ...resistanceTrendlines].sort(
    (a, b) => a.startIndex - b.startIndex,
  );

  return {
    trendlines,
    params: resolved,
  };
};

export const getEventDefinitions = () => Object.values(TRENDLINE_V1_EVENT_DEFINITIONS);

type TrendlineV1BreachPayload = TrendlineBreachEventPayloadBase & { version: 1 };

type TrendlineV1Event = IndicatorEvent<TrendlineV1BreachPayload>;

export const detectEvents = (
  candles: Candle[],
  params?: TrendlineV1Params,
): TrendlineV1Event[] => {
  if (!candles.length) {
    return [];
  }

  const { trendlines } = computeTrendlinesV1(candles, params);

  const eventMap = new Map<string, TrendlineV1Event>();
  const eventDistance = new Map<string, number>();

  for (const line of trendlines) {
    const shouldLimitCandles = !line.isActive && line.endIndex < candles.length - 1;

    const evaluationCandles = shouldLimitCandles
      ? candles.slice(0, Math.max(line.endIndex + 1, 2))
      : candles;

    const evaluation = evaluateTrendlineBreaches(evaluationCandles, {
      type: line.type,
      startIndex: line.startIndex,
      endIndex: line.endIndex,
      startPrice: line.start.price,
      slope: line.slope,
      activationIndex: line.anchorEndIndex,
      breachedAtIndex: line.isActive ? undefined : line.endIndex,
    });
    const shared = {
      lineType: line.type,
      slope: line.slope,
      startIndex: line.startIndex,
      endIndex: line.endIndex,
    };

    const boundedStart = line.startIndex;
    const boundedEnd = line.endIndex;

    const evaluationEvents = [
      ...evaluation.breaches.map((detail) => ({
        definition: getTrendlineV1Definition(detail.breakType, 'intraday'),
        variant: 'intraday' as const,
        detail,
      })),
      ...evaluation.breachCloses.map((detail) => ({
        definition: getTrendlineV1Definition(detail.breakType, 'close'),
        variant: 'close' as const,
        detail,
      })),
    ]
      // Only keep events that occur while the line is defined on the chart
      .filter((entry) => entry.detail.index >= boundedStart && entry.detail.index <= boundedEnd);

    evaluationEvents.sort((a, b) => {
      if (a.detail.index !== b.detail.index) {
        return a.detail.index - b.detail.index;
      }
      if (a.variant === b.variant) {
        return 0;
      }
      return a.variant === 'intraday' ? -1 : 1;
    });

    for (const entry of evaluationEvents) {
      if (!isSlopeDirectionCompatible(line.slope, entry.detail.breakType)) {
        continue;
      }

      const priceReference =
        entry.variant === 'intraday' ? entry.detail.extremePrice : entry.detail.close;
      const distance = Math.abs(entry.detail.linePrice - priceReference);

      const indicatorEvent = createIndicatorEvent(entry.definition, {
        candle: candles[entry.detail.index],
        index: entry.detail.index,
        t: entry.detail.t,
        payload: {
          ...shared,
          variant: entry.variant,
          detail: entry.detail,
          version: 1 as const,
        },
      });

      const key = `${indicatorEvent.id}:${entry.detail.index}:${entry.detail.breakType}:${entry.variant}`;
      const currentDistance = eventDistance.get(key);
      if (currentDistance === undefined || distance < currentDistance) {
        eventDistance.set(key, distance);
        eventMap.set(key, indicatorEvent);
      }
    }
  }

  const resolveEventIndex = (event: TrendlineV1Event): number => {
    if (Number.isFinite(event.index)) {
      return event.index as number;
    }
    return event.payload?.detail?.index ?? 0;
  };

  const breachEvents = Array.from(eventMap.values()).sort(
    (a, b) => resolveEventIndex(a) - resolveEventIndex(b),
  );
  return breachEvents;
};
