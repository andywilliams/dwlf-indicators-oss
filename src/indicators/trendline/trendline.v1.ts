import type { Candle, IndicatorEvent } from '../../types';
import { computeSwings } from '../swing/swing';
import { evaluateTrendlineBarBreach } from './breachBar';
import type { TrendlineBreachDetail } from './breachBar';
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
  lastIndex = candles.length - 1,
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
    let extendedEndIndex = lastIndex;
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
      extendedEndIndex = lastIndex;
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

type TrendlineV1BreachPayload = TrendlineBreachEventPayloadBase & {
  version: 1;
  /** The line's second pivot: it became knowable `swingLookback` bars later. */
  anchorIndex: number;
};

type TrendlineV1Event = IndicatorEvent<TrendlineV1BreachPayload>;

// A line as a live run sees it: drawn from the pivots knowable so far, and
// spent once a close has broken it.
type LiveLine = { line: TrendlineV1; spent: boolean };

const lineKey = (line: TrendlineV1) => `${line.type}:${line.startIndex}:${line.anchorEndIndex}`;

/**
 * DWLF-330: a break fires on the bar it happens, measured only against lines
 * a live run could draw on that bar. A swing pivot is knowable `swingLookback`
 * bars after it, so on bar k the lines are the ones drawn from the pivots
 * knowable by k, and a line the next pivot has not yet terminated is still
 * active. Each bar is judged from that bar and the one before it, against the
 * lines as of that bar, so a run cut at any bar emits exactly the full run's
 * events up to it, and the payload (`endIndex` included) is state as of the
 * break.
 */
export const detectEvents = (
  candles: Candle[],
  params?: TrendlineV1Params,
): TrendlineV1Event[] => {
  if (!candles.length) {
    return [];
  }

  const { swingLookback } = resolveParams(params);
  const { highs, lows } = computeSwings(candles, { lookback: swingLookback });
  const knownCount = (points: SwingPoint[], from: number, k: number) => {
    let count = from;
    while (count < points.length && points[count].index + swingLookback <= k) {
      count += 1;
    }
    return count;
  };

  // The active lines of each direction, carried from one bar to the next. A
  // line keeps its spent state only while it stays drawn: one that drops out
  // and is drawn again was not judged in between, so it is checked afresh.
  let support: LiveLine[] = [];
  let resistance: LiveLine[] = [];
  let knownLows = 0;
  let knownHighs = 0;
  const events: TrendlineV1Event[] = [];

  // Whether a close broke the line on any bar from its activation up to `k`.
  const spentBefore = (line: TrendlineV1, k: number) => {
    for (let index = line.anchorEndIndex + 1; index < k; index += 1) {
      if (evaluateTrendlineBarBreach(candles, toTrendlineLike(line), index, line.anchorEndIndex).breachClose) {
        return true;
      }
    }
    return false;
  };

  const redraw = (
    previous: LiveLine[],
    points: SwingPoint[],
    groups: SwingPoint[][],
    direction: 'support' | 'resistance',
    k: number,
  ): LiveLine[] => {
    const carried = new Map(previous.map((entry) => [lineKey(entry.line), entry]));
    return generateTrendlines(groups, candles, points, direction, k)
      .filter((line) => line.isActive)
      .map((line) => carried.get(lineKey(line)) ?? { line, spent: spentBefore(line, k) });
  };

  for (let k = 1; k < candles.length; k += 1) {
    const lowsNow = knownCount(lows, knownLows, k);
    if (lowsNow !== knownLows) {
      knownLows = lowsNow;
      const known = lows.slice(0, knownLows);
      support = redraw(support, known, groupUpwardSwingLows(known), 'support', k);
    }
    const highsNow = knownCount(highs, knownHighs, k);
    if (highsNow !== knownHighs) {
      knownHighs = highsNow;
      const known = highs.slice(0, knownHighs);
      resistance = redraw(resistance, known, groupDownwardSwingHighs(known), 'resistance', k);
    }
    const live = [...support, ...resistance];

    const best = new Map<string, { event: TrendlineV1Event; distance: number }>();
    for (const entry of live) {
      if (entry.spent) {
        continue;
      }
      const { line } = entry;
      const { breach, breachClose } = evaluateTrendlineBarBreach(candles, toTrendlineLike(line), k, line.anchorEndIndex);
      if (breachClose) {
        entry.spent = true;
      }
      const found: Array<{ variant: 'intraday' | 'close'; detail: TrendlineBreachDetail }> = [];
      if (breach) {
        found.push({ variant: 'intraday', detail: breach });
      }
      if (breachClose) {
        found.push({ variant: 'close', detail: breachClose });
      }
      for (const { variant, detail } of found) {
        if (!isSlopeDirectionCompatible(line.slope, detail.breakType)) {
          continue;
        }
        const definition = getTrendlineV1Definition(detail.breakType, variant);
        const priceReference = variant === 'intraday' ? detail.extremePrice : detail.close;
        const distance = Math.abs(detail.linePrice - priceReference);
        const event = createIndicatorEvent(definition, {
          candle: candles[k],
          index: k,
          t: detail.t,
          payload: {
            lineType: line.type,
            slope: line.slope,
            startIndex: line.startIndex,
            endIndex: k,
            anchorIndex: line.anchorEndIndex,
            variant,
            detail,
            version: 1 as const,
          },
        });
        const key = `${definition.id}:${detail.breakType}:${variant}`;
        const current = best.get(key);
        if (current === undefined || distance < current.distance) {
          best.set(key, { event, distance });
        }
      }
    }
    // Intraday before close on the same bar, as before.
    const order = (e: TrendlineV1Event) => (e.payload?.variant === 'intraday' ? 0 : 1);
    events.push(...[...best.values()].map((b) => b.event).sort((a, b) => order(a) - order(b)));
  }

  return events;
};

const toTrendlineLike = (line: TrendlineV1) => ({
  type: line.type,
  startIndex: line.startIndex,
  endIndex: line.endIndex,
  startPrice: line.start.price,
  slope: line.slope,
});
