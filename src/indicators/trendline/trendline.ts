import type { Candle, IndicatorEvent } from '../../types';
import { atr as wilderAtr } from '../../math/atr';
import { computeSwings } from '../swing/swing';
import type { SwingHigh, SwingLow } from '../swing/swing';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import {
  evaluateTrendlineBreaches,
  getLinePriceAtIndex,
  type TrendlineBreachDetail,
} from './breachDetection';
import { isSlopeDirectionCompatible } from './slopeGuards';
import { createIndicatorEvent } from '../../utils/events';

type Direction = 'support' | 'resistance';
type PriceSource = 'low' | 'high' | 'close';
type BreachDetectionMode = 'percentage' | 'atr';

export type TrendlineParams = {
  swingLookback?: number;
  minSwingLowTolerancePct?: number;
  minSlopePctPerCandle?: number;
  breachDetectionMode?: BreachDetectionMode;
  breachThreshold?: number;
  atrPeriod?: number;
  breachRequireConsecutive?: number;
  slopePriceSource?: PriceSource;
  supportSlopePriceSource?: PriceSource;
  resistanceSlopePriceSource?: PriceSource;
  minSegmentLength?: number;
  minSlopeDeltaPct?: number;
  allowAnchorDrift?: boolean;
  maxAnchorDriftPct?: number;
  maxAnchorDriftBars?: number;
};

export type ResolvedTrendlineParams = {
  swingLookback: number;
  minSwingLowTolerancePct: number;
  minSlopePctPerCandle: number;
  breachDetectionMode: BreachDetectionMode;
  breachThreshold: number;
  atrPeriod: number;
  breachRequireConsecutive: number;
  supportSlopePriceSource: PriceSource;
  resistanceSlopePriceSource: PriceSource;
  minSegmentLength: number;
  minSlopeDeltaPct: number;
  allowAnchorDrift: boolean;
  maxAnchorDriftPct: number;
  maxAnchorDriftBars: number;
};

const DEFAULT_PARAMS: ResolvedTrendlineParams = {
  swingLookback: 3,
  minSwingLowTolerancePct: 1,
  minSlopePctPerCandle: 0.0005,
  breachDetectionMode: 'percentage',
  breachThreshold: 1.5,
  atrPeriod: 14,
  breachRequireConsecutive: 1,
  supportSlopePriceSource: 'low',
  resistanceSlopePriceSource: 'high',
  minSegmentLength: 3,
  minSlopeDeltaPct: 10,
  allowAnchorDrift: true,
  maxAnchorDriftPct: 0.3,
  maxAnchorDriftBars: 5,
};

const TRENDLINE_EVENT_DEFINITIONS = {
  BREACH_BULLISH: {
    id: 'trendline_breach_bullish',
    name: 'Trendline Breach (Bullish)',
    description: 'Price wicked through a resistance trendline, signalling a potential bullish breakout.',
  },
  BREACH_BEARISH: {
    id: 'trendline_breach_bearish',
    name: 'Trendline Breach (Bearish)',
    description: 'Price wicked through a support trendline, signalling a potential bearish breakdown.',
  },
  BREAK_BULLISH: {
    id: 'trendline_break_bullish',
    name: 'Trendline Break (Bullish Close)',
    description: 'The candle close moved beyond a resistance trendline, confirming a bullish breakout.',
  },
  BREAK_BEARISH: {
    id: 'trendline_break_bearish',
    name: 'Trendline Break (Bearish Close)',
    description: 'The candle close dropped below a support trendline, confirming a bearish breakdown.',
  },
} as const;

const getTrendlineEventDefinition = (
  breakType: 'support_break' | 'resistance_break',
  variant: 'intraday' | 'close',
) => {
  const isBullish = breakType === 'resistance_break';
  if (variant === 'intraday') {
    return isBullish
      ? TRENDLINE_EVENT_DEFINITIONS.BREACH_BULLISH
      : TRENDLINE_EVENT_DEFINITIONS.BREACH_BEARISH;
  }

  return isBullish
    ? TRENDLINE_EVENT_DEFINITIONS.BREAK_BULLISH
    : TRENDLINE_EVENT_DEFINITIONS.BREAK_BEARISH;
};

const isValidPriceSource = (value: string): value is PriceSource =>
  value === 'low' || value === 'high' || value === 'close';

export const resolveTrendlineParams = (params: TrendlineParams = {}): ResolvedTrendlineParams => {
  const resolved: ResolvedTrendlineParams = {
    swingLookback: params.swingLookback ?? DEFAULT_PARAMS.swingLookback,
    minSwingLowTolerancePct: params.minSwingLowTolerancePct ?? DEFAULT_PARAMS.minSwingLowTolerancePct,
    minSlopePctPerCandle: params.minSlopePctPerCandle ?? DEFAULT_PARAMS.minSlopePctPerCandle,
    breachDetectionMode: params.breachDetectionMode ?? DEFAULT_PARAMS.breachDetectionMode,
    breachThreshold: params.breachThreshold ?? DEFAULT_PARAMS.breachThreshold,
    atrPeriod: params.atrPeriod ?? DEFAULT_PARAMS.atrPeriod,
    breachRequireConsecutive: params.breachRequireConsecutive ?? DEFAULT_PARAMS.breachRequireConsecutive,
    supportSlopePriceSource:
      params.supportSlopePriceSource ??
      params.slopePriceSource ??
      DEFAULT_PARAMS.supportSlopePriceSource,
    resistanceSlopePriceSource:
      params.resistanceSlopePriceSource ??
      params.slopePriceSource ??
      DEFAULT_PARAMS.resistanceSlopePriceSource,
    minSegmentLength: params.minSegmentLength ?? DEFAULT_PARAMS.minSegmentLength,
    minSlopeDeltaPct: params.minSlopeDeltaPct ?? DEFAULT_PARAMS.minSlopeDeltaPct,
    allowAnchorDrift: params.allowAnchorDrift ?? DEFAULT_PARAMS.allowAnchorDrift,
    maxAnchorDriftPct: params.maxAnchorDriftPct ?? DEFAULT_PARAMS.maxAnchorDriftPct,
    maxAnchorDriftBars: params.maxAnchorDriftBars ?? DEFAULT_PARAMS.maxAnchorDriftBars,
  };

  assertPositiveInteger(resolved.swingLookback, 'swingLookback');
  assertPositiveInteger(resolved.atrPeriod, 'atrPeriod');
  assertPositiveInteger(resolved.breachRequireConsecutive, 'breachRequireConsecutive');
  assertPositiveInteger(resolved.minSegmentLength, 'minSegmentLength');
  assertPositiveInteger(resolved.maxAnchorDriftBars, 'maxAnchorDriftBars');

  if (!isFiniteNumber(resolved.minSwingLowTolerancePct) || resolved.minSwingLowTolerancePct < 0) {
    throw new TypeError(
      `minSwingLowTolerancePct must be a non-negative finite number. Received: ${params.minSwingLowTolerancePct}`,
    );
  }

  if (!isFiniteNumber(resolved.minSlopePctPerCandle) || resolved.minSlopePctPerCandle < 0) {
    throw new TypeError(
      `minSlopePctPerCandle must be a non-negative finite number. Received: ${params.minSlopePctPerCandle}`,
    );
  }

  if (resolved.breachDetectionMode !== 'percentage' && resolved.breachDetectionMode !== 'atr') {
    throw new TypeError(
      `breachDetectionMode must be either "percentage" or "atr". Received: ${params.breachDetectionMode}`,
    );
  }

  if (!isFiniteNumber(resolved.breachThreshold) || resolved.breachThreshold <= 0) {
    throw new TypeError(
      `breachThreshold must be a positive finite number. Received: ${params.breachThreshold}`,
    );
  }

  if (!isValidPriceSource(resolved.supportSlopePriceSource)) {
    throw new TypeError(
      `supportSlopePriceSource must be one of "low", "high", or "close". Received: ${params.supportSlopePriceSource}`,
    );
  }

  if (!isValidPriceSource(resolved.resistanceSlopePriceSource)) {
    throw new TypeError(
      `resistanceSlopePriceSource must be one of "low", "high", or "close". Received: ${params.resistanceSlopePriceSource}`,
    );
  }

  if (!isFiniteNumber(resolved.minSlopeDeltaPct) || resolved.minSlopeDeltaPct < 0) {
    throw new TypeError(
      `minSlopeDeltaPct must be a non-negative finite number. Received: ${params.minSlopeDeltaPct}`,
    );
  }

  if (!isFiniteNumber(resolved.maxAnchorDriftPct) || resolved.maxAnchorDriftPct < 0) {
    throw new TypeError(
      `maxAnchorDriftPct must be a non-negative finite number. Received: ${params.maxAnchorDriftPct}`,
    );
  }

  return resolved;
};

type NormalisedCandle = Candle & { index: number };

const normaliseCandles = (candles: Candle[]): NormalisedCandle[] =>
  candles.map((candle, index) => ({ ...candle, index }));

const toNumber = (value: number | undefined): number | undefined =>
  value === undefined || value === null ? undefined : Number(value);

const getAtrAt = (atrSeries: Array<number | undefined>, index: number): number => {
  const direct = atrSeries[index];
  if (direct !== undefined) {
    return direct;
  }

  for (let i = index; i >= 0; i -= 1) {
    const fallback = atrSeries[i];
    if (fallback !== undefined) {
      return fallback;
    }
  }

  return 0;
};

const resolvePriceSource = (direction: Direction, config: ResolvedTrendlineParams): PriceSource =>
  direction === 'support' ? config.supportSlopePriceSource : config.resistanceSlopePriceSource;

type SwingPoint = SwingHigh | SwingLow;

const getSwingPrice = (
  candles: NormalisedCandle[],
  swing: SwingPoint,
  priceSource: PriceSource,
  fallback: number,
): number => {
  const candle = candles[swing.index];
  if (!candle) {
    return fallback;
  }

  if (priceSource === 'low') {
    return toNumber(candle.l) ?? fallback;
  }
  if (priceSource === 'high') {
    return toNumber(candle.h) ?? fallback;
  }
  if (priceSource === 'close') {
    return toNumber(candle.c) ?? fallback;
  }
  return fallback;
};

type TrendlinePoint = {
  index: number;
  price: number;
  t: number;
};

type BreachMeta = {
  index: number;
  t: number;
  close: number;
};

type TrendlineMeta = {
  direction: Direction;
  slopePctPerCandle: number;
  magnitudePctPerCandle: number;
  priceSource: PriceSource;
  sequenceId: number;
  breachDetectionMode: BreachDetectionMode;
  tolerancePct: number;
  adjusted?: boolean;
  breachedAt?: BreachMeta;
  terminatedBy?: string;
};

type TrendlineInternalMeta = TrendlineMeta & { consecutiveBreaches: number };

type TrendlineInternal = {
  start: TrendlinePoint;
  end: TrendlinePoint;
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  slope: number;
  intercept: number;
  isActive: boolean;
  version: number;
  type: Direction;
  lastEvaluatedIndex: number;
  meta: TrendlineInternalMeta;
};

export type Trendline = Omit<TrendlineInternal, 'lastEvaluatedIndex' | 'meta'> & {
  meta: TrendlineMeta;
};

type EvaluateActiveLinesInput = {
  activeLines: TrendlineInternal[];
  candles: NormalisedCandle[];
  atrSeries: Array<number | undefined>;
  config: ResolvedTrendlineParams;
  direction: Direction;
  targetIndex: number;
};

const isSupportBreach = (
  linePrice: number,
  close: number,
  atr: number,
  config: ResolvedTrendlineParams,
): boolean => {
  const distance = linePrice - close;
  if (distance <= 0) {
    return false;
  }

  if (config.breachDetectionMode === 'atr') {
    const threshold = atr * config.breachThreshold;
    return threshold > 0 && distance >= threshold;
  }

  const pctBelow = (distance / linePrice) * 100;
  return pctBelow >= config.breachThreshold;
};

const isResistanceBreach = (
  linePrice: number,
  close: number,
  atr: number,
  config: ResolvedTrendlineParams,
): boolean => {
  const distance = close - linePrice;
  if (distance <= 0) {
    return false;
  }

  if (config.breachDetectionMode === 'atr') {
    const threshold = atr * config.breachThreshold;
    return threshold > 0 && distance >= threshold;
  }

  const pctAbove = (distance / linePrice) * 100;
  return pctAbove >= config.breachThreshold;
};

const evaluateActiveLinesUpTo = ({
  activeLines,
  candles,
  atrSeries,
  config,
  direction,
  targetIndex,
}: EvaluateActiveLinesInput): TrendlineInternal[] => {
  const lastIndex = Math.min(Math.max(targetIndex, 0), candles.length - 1);
  const remaining: TrendlineInternal[] = [];

  for (const line of activeLines) {
    if (!line.isActive) {
      continue;
    }

    const start = Math.max(line.lastEvaluatedIndex + 1, line.startIndex);
    const end = Math.max(start, lastIndex);

    for (let index = start; index <= end; index += 1) {
      const candle = candles[index];
      if (!candle) {
        continue;
      }
      const linePrice = getLinePriceAtIndex(line, index);
      const atr = getAtrAt(atrSeries, index);

      line.end = {
        index,
        price: linePrice,
        t: candle.t,
      };
      line.endIndex = index;
      line.endPrice = linePrice;

      const breachDetected =
        direction === 'support'
          ? isSupportBreach(linePrice, candle.c, atr, config)
          : isResistanceBreach(linePrice, candle.c, atr, config);

      if (breachDetected) {
        line.meta.consecutiveBreaches = (line.meta.consecutiveBreaches || 0) + 1;
        if (
          line.meta.consecutiveBreaches >= config.breachRequireConsecutive &&
          !line.meta.breachedAt
        ) {
          line.meta.breachedAt = {
            index,
            t: candle.t,
            close: candle.c,
          };
        }
      } else {
        line.meta.consecutiveBreaches = 0;
      }
    }

    line.lastEvaluatedIndex = Math.max(line.lastEvaluatedIndex, end);

    if (line.isActive) {
      remaining.push(line);
    }
  }

  return remaining;
};

const archiveLines = (activeLines: TrendlineInternal[], reason: string): void => {
  activeLines.forEach((line) => {
    if (line.isActive) {
      line.isActive = false;
      line.meta.terminatedBy = reason;
    }
  });
  activeLines.length = 0;
};

type CreateTrendlineInput = {
  direction: Direction;
  startSwing: SwingPoint;
  startPrice: number;
  endSwing: SwingPoint;
  endPrice: number;
  candles: NormalisedCandle[];
  config: ResolvedTrendlineParams;
  sequenceId: number;
};

const createTrendline = ({
  direction,
  startSwing,
  startPrice,
  endSwing,
  endPrice,
  candles,
  config,
  sequenceId,
}: CreateTrendlineInput): TrendlineInternal | null => {
  const candleDistance = endSwing.index - startSwing.index;
  if (candleDistance < config.minSegmentLength) {
    return null;
  }

  const slopePerIndex = (endPrice - startPrice) / candleDistance;
  const intercept = startPrice - slopePerIndex * startSwing.index;
  const slopePctPerCandle = ((endPrice - startPrice) / startPrice) / candleDistance;
  const magnitudePctPerCandle = Math.abs(slopePctPerCandle);
  const priceSource = resolvePriceSource(direction, config);

  const startCandle = candles[startSwing.index];
  const endCandle = candles[endSwing.index];

  const line: TrendlineInternal = {
    start: {
      index: startSwing.index,
      price: startPrice,
      t: startCandle?.t ?? startSwing.candle?.t ?? 0,
    },
    end: {
      index: endSwing.index,
      price: endPrice,
      t: endCandle?.t ?? endSwing.candle?.t ?? 0,
    },
    startIndex: startSwing.index,
    endIndex: endSwing.index,
    startPrice,
    endPrice,
    slope: slopePerIndex,
    intercept,
    isActive: true,
    version: 2,
    type: direction,
    lastEvaluatedIndex: endSwing.index,
    meta: {
      direction,
      slopePctPerCandle,
      magnitudePctPerCandle,
      priceSource,
      sequenceId,
      breachDetectionMode: config.breachDetectionMode,
      tolerancePct: config.minSwingLowTolerancePct,
      consecutiveBreaches: 0,
    },
  };

  return line;
};

const isSlopeValid = (
  direction: Direction,
  slopePctPerCandle: number,
  minSlopePctPerCandle: number,
): boolean =>
  direction === 'support'
    ? slopePctPerCandle > 0 && slopePctPerCandle >= minSlopePctPerCandle
    : slopePctPerCandle < 0 && Math.abs(slopePctPerCandle) >= minSlopePctPerCandle;

const slopesAreSimilar = (slopeA: number, slopeB: number, tolerancePercent = 5): boolean => {
  if (slopeA === 0) {
    return false;
  }
  const diffPct = Math.abs((slopeB - slopeA) / slopeA) * 100;
  return diffPct <= tolerancePercent;
};

type GenerateTrendlinesArgs = {
  direction: Direction;
  swings: SwingPoint[];
  candles: NormalisedCandle[];
  atrSeries: Array<number | undefined>;
  config: ResolvedTrendlineParams;
};

const generateTrendlinesForDirection = ({
  direction,
  swings,
  candles,
  atrSeries,
  config,
}: GenerateTrendlinesArgs): TrendlineInternal[] => {
  if (!swings.length) {
    return [];
  }

  const priceSource = resolvePriceSource(direction, config);
  const tolerancePct = config.minSwingLowTolerancePct || 0;
  const minSlope = config.minSlopePctPerCandle || 0;
  const minSegmentLength = config.minSegmentLength || 3;
  const minSlopeDeltaPct = config.minSlopeDeltaPct || 10;

  const sortedSwings = [...swings].sort((a, b) => a.index - b.index);

  const lines: TrendlineInternal[] = [];
  const activeLines: TrendlineInternal[] = [];

  let previous: { swing: SwingPoint; price: number } | null = null;
  let sequenceId = 0;

  for (const swing of sortedSwings) {
    const price = getSwingPrice(candles, swing, priceSource, swing.price);

    if (!previous) {
      previous = { swing, price };
      sequenceId += 1;
      continue;
    }

    activeLines.splice(
      0,
      activeLines.length,
      ...evaluateActiveLinesUpTo({
        activeLines,
        candles,
        atrSeries,
        config,
        direction,
        targetIndex: swing.index,
      }),
    );

    const prevPrice = previous.price;
    const toleranceMul = tolerancePct / 100;

    let breaksSequence = false;
    if (direction === 'support') {
      const minAllowed = prevPrice * (1 - toleranceMul);
      if (price < minAllowed) {
        breaksSequence = true;
      }
    } else {
      const maxAllowed = prevPrice * (1 + toleranceMul);
      if (price > maxAllowed) {
        breaksSequence = true;
      }
    }

    if (breaksSequence) {
      const lastActive = activeLines[activeLines.length - 1];
      if (lastActive) {
        const projectedPrice = getLinePriceAtIndex(lastActive, swing.index);
        if (direction === 'support') {
          const breachThreshold = projectedPrice * (1 - tolerancePct / 100);
          if (price < breachThreshold) {
            lastActive.end = {
              index: swing.index,
              price: projectedPrice,
              t: candles[swing.index]?.t ?? swing.candle?.t ?? lastActive.end.t,
            };
            lastActive.endIndex = swing.index;
            lastActive.endPrice = projectedPrice;
            lastActive.meta.breachedAt = {
              index: swing.index,
              t: candles[swing.index]?.t ?? swing.candle?.t ?? lastActive.end.t,
              close: candles[swing.index]?.c ?? price,
            };
            archiveLines(activeLines, 'breach');
          }
        } else {
          const breachThreshold = projectedPrice * (1 + tolerancePct / 100);
          if (price > breachThreshold) {
            lastActive.end = {
              index: swing.index,
              price: projectedPrice,
              t: candles[swing.index]?.t ?? swing.candle?.t ?? lastActive.end.t,
            };
            lastActive.endIndex = swing.index;
            lastActive.endPrice = projectedPrice;
            lastActive.meta.breachedAt = {
              index: swing.index,
              t: candles[swing.index]?.t ?? swing.candle?.t ?? lastActive.end.t,
              close: candles[swing.index]?.c ?? price,
            };
            archiveLines(activeLines, 'breach');
          }
        }
      }
      sequenceId += 1;
      previous = { swing, price };
      continue;
    }

    const candleDistance = swing.index - previous.swing.index;
    if (candleDistance < minSegmentLength) {
      previous = { swing, price };
      continue;
    }

    const slopePctPerCandle = ((price - prevPrice) / prevPrice) / candleDistance;
    if (!isSlopeValid(direction, slopePctPerCandle, minSlope)) {
      previous = { swing, price };
      continue;
    }

    const slopeTooClose = activeLines.some((line) => {
      if (line.startIndex !== previous!.swing.index) {
        return false;
      }
      return slopesAreSimilar(line.meta.slopePctPerCandle, slopePctPerCandle, 5);
    });

    if (slopeTooClose) {
      previous = { swing, price };
      continue;
    }

    const comparableLines = lines.filter(
      (line) =>
        line.meta.sequenceId === sequenceId &&
        line.startIndex < previous!.swing.index &&
        line.endIndex > previous!.swing.index,
    );

    if (comparableLines.length > 0) {
      const slopes = comparableLines.map((line) => line.meta.slopePctPerCandle);

      if (direction === 'support') {
        const maxSlope = Math.max(...slopes);
        const slopeDeltaPct = ((slopePctPerCandle - maxSlope) / Math.abs(maxSlope)) * 100;
        if (slopeDeltaPct < minSlopeDeltaPct) {
          previous = { swing, price };
          continue;
        }
      } else {
        const minSlopeValue = Math.min(...slopes);
        const slopeDeltaPct =
          ((Math.abs(slopePctPerCandle) - Math.abs(minSlopeValue)) / Math.abs(minSlopeValue)) *
          100;
        if (slopeDeltaPct < minSlopeDeltaPct) {
          previous = { swing, price };
          continue;
        }
      }
    }

    if (config.allowAnchorDrift && lines.length > 0) {
      const recentLine = lines[lines.length - 1];
      const barsSinceLast = swing.index - recentLine.endIndex;
      if (barsSinceLast > 0 && barsSinceLast <= config.maxAnchorDriftBars && recentLine.isActive) {
        const expectedEndPrice = getLinePriceAtIndex(recentLine, swing.index);
        const deltaPct = Math.abs((price - expectedEndPrice) / expectedEndPrice) * 100;

        if (deltaPct <= config.maxAnchorDriftPct) {
          recentLine.endIndex = swing.index;
          recentLine.endPrice = price;
          recentLine.end = {
            index: swing.index,
            price,
            t: candles[swing.index]?.t ?? swing.candle?.t ?? recentLine.end.t,
          };
          recentLine.meta.adjusted = true;
          previous = { swing, price };
          continue;
        }
      }
    }

    const line = createTrendline({
      direction,
      startSwing: previous.swing,
      startPrice: prevPrice,
      endSwing: swing,
      endPrice: price,
      candles,
      config,
      sequenceId,
    });

    if (line) {
      lines.push(line);
      activeLines.push(line);
    }

    previous = { swing, price };
  }

  activeLines.splice(
    0,
    activeLines.length,
    ...evaluateActiveLinesUpTo({
      activeLines,
      candles,
      atrSeries,
      config,
      direction,
      targetIndex: candles.length - 1,
    }),
  );

  return lines;
};

export type TrendlineResult = {
  trendlines: Trendline[];
  params: ResolvedTrendlineParams;
};

export const computeTrendlines = (
  candles: Candle[],
  params?: TrendlineParams,
): TrendlineResult => {
  const resolved = resolveTrendlineParams(params);
  const normalised = normaliseCandles(candles);

  if (normalised.length < 3) {
    return { trendlines: [], params: resolved };
  }

  const atrSeries = wilderAtr(normalised, resolved.atrPeriod);
  const { highs, lows } = computeSwings(normalised, { lookback: resolved.swingLookback });

  const supportTrendlines = generateTrendlinesForDirection({
    direction: 'support',
    swings: lows,
    candles: normalised,
    atrSeries,
    config: resolved,
  });

  const resistanceTrendlines = generateTrendlinesForDirection({
    direction: 'resistance',
    swings: highs,
    candles: normalised,
    atrSeries,
    config: resolved,
  });

  const combined = [...supportTrendlines, ...resistanceTrendlines].sort(
    (a, b) => a.start.index - b.start.index,
  );

  const trendlines: Trendline[] = combined.map((line) => {
    // Remove internal bookkeeping fields before returning
    const { meta: internalMeta, ...rest } = line;
    const { consecutiveBreaches, ...meta } = internalMeta;
    void consecutiveBreaches; // explicitly ignore
    return {
      ...rest,
      meta,
    };
  });

  return {
    trendlines,
    params: resolved,
  };
};

export type TrendlineBreachEventPayloadBase = {
  lineType: Trendline['type'];
  slope: number;
  startIndex: number;
  endIndex: number;
  variant: 'intraday' | 'close';
  detail: TrendlineBreachDetail;
};

export type TrendlineBreachEventPayload = TrendlineBreachEventPayloadBase & { version: 2 };

export const getEventDefinitions = () => Object.values(TRENDLINE_EVENT_DEFINITIONS);

export const detectEvents = (
  candles: Candle[],
  params?: TrendlineParams,
): IndicatorEvent<TrendlineBreachEventPayload>[] => {
  if (!candles.length) {
    return [];
  }

  const { trendlines } = computeTrendlines(candles, params);
  const eventMap = new Map<string, IndicatorEvent<TrendlineBreachEventPayload>>();
  const eventDistance = new Map<string, number>();

  for (const line of trendlines) {
    const activationIndex =
      line.meta.breachedAt && Number.isFinite(line.meta.breachedAt.index)
        ? Math.max((line.meta.breachedAt.index ?? 0) - 1, line.start.index)
        : undefined;

    const evaluation = evaluateTrendlineBreaches(candles, {
      ...line,
      activationIndex,
      breachedAtIndex: line.meta.breachedAt?.index,
    });
    const basePayload: Omit<TrendlineBreachEventPayloadBase, 'variant' | 'detail'> = {
      lineType: line.type,
      slope: line.slope,
      startIndex: line.start.index,
      endIndex: line.end.index,
    };

    const boundedStart = line.start.index;
    const boundedEnd = line.end.index;

    const evaluationEvents = [
      ...evaluation.breaches.map((detail) => ({
        definition: getTrendlineEventDefinition(detail.breakType, 'intraday'),
        variant: 'intraday' as const,
        detail,
      })),
      ...evaluation.breachCloses.map((detail) => ({
        definition: getTrendlineEventDefinition(detail.breakType, 'close'),
        variant: 'close' as const,
        detail,
      })),
    ]
      // Only keep events that occur while the line is defined on the chart
      .filter((entry) => entry.detail.index >= boundedStart && entry.detail.index <= boundedEnd)
      .sort((a, b) => {
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
          ...basePayload,
          version: 2 as const,
          variant: entry.variant,
          detail: entry.detail,
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

  const resolveEventIndex = (event: IndicatorEvent<TrendlineBreachEventPayload>): number => {
    if (Number.isFinite(event.index)) {
      return event.index as number;
    }
    return event.payload?.detail?.index ?? 0;
  };

  return Array.from(eventMap.values()).sort(
    (a, b) => resolveEventIndex(a) - resolveEventIndex(b),
  );
};
