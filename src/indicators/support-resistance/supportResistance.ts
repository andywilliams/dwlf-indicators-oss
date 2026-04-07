import type { Candle, IndicatorEvent } from '../../types';
import { createIndicatorEvent } from '../../utils/events';
import { computeSwings } from '../swing/swing';
import { getTrackerEventDefinitions } from './supportResistanceTracker';

export { SupportResistanceTracker, getTrackerEventDefinitions } from './supportResistanceTracker';
export type { TrackedLevel, LevelState, LevelHistory, TrackerOptions } from './supportResistanceTracker';

export type SupportResistanceInputCandle = Partial<Candle> & {
  date?: string | number;
  datetime?: string | number;
  time?: string | number;
  timestamp?: number;
  ts?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  Open?: number;
  High?: number;
  Low?: number;
  Close?: number;
};

export type LevelTier = 'local' | 'intermediate' | 'structural';

export type LevelStrength = {
  touchCount: number;
  bounceStrength: number;
  volumeScore: number;
  recencyScore: number;
  tierBonus: number;
  overall: number;
};

export type SupportResistanceLevel = {
  level: number;
  touches: number;
  bounce: number;
  bounceStrength: number;
  score: number;
  count: number;
  extremityFactor: number;
  extremityMultiplier: number;
  zone?: {
    center: number;
    upper: number;
    lower: number;
  };
  side?: 'support' | 'resistance';
  id?: string;
  tier?: LevelTier;
  strength?: LevelStrength;
  state?: 'active' | 'tested' | 'broken' | 'flipped' | 'expired';
  history?: {
    originalSide: 'support' | 'resistance';
    breakIndex?: number;
    flipCount: number;
  };
};

export type SupportResistanceResult = {
  support: SupportResistanceLevel[];
  resistance: SupportResistanceLevel[];
  priceRangeHigh: number;
  priceRangeLow: number;
  sourceLength: number;
};

export type SupportResistanceOptions = {
  clusterThreshold?: number;
  minTouches?: number;
  maxLevelsPerSide?: number;
  touchWeight?: number;
  bounceWeight?: number;
  extremityWeight?: number;
  lookback?: number;
  tiers?: Array<LevelTier>;
  tierLookbacks?: Record<string, number>;
  recencyHalfLife?: number;
  volumeWeight?: number;
};

type InternalSupportResistanceOptions = Required<Omit<SupportResistanceOptions, 'maxLevelsPerSide' | 'tiers' | 'tierLookbacks'>> & {
  maxLevelsPerSide: number;
  lookback: number;
  tiers: Array<LevelTier>;
  tierLookbacks: Record<string, number>;
};

export type SupportResistanceEventOptions = SupportResistanceOptions & {
  priceNearThresholdPct?: number;
};

const DEFAULT_TIER_LOOKBACKS: Record<string, number> = {
  local: 3,
  intermediate: 8,
  structural: 21,
};

const TIER_ORDER: Record<LevelTier, number> = {
  local: 0,
  intermediate: 1,
  structural: 2,
};

const TIER_BONUS: Record<LevelTier, number> = {
  local: 1.0,
  intermediate: 1.2,
  structural: 1.5,
};

const DEFAULT_OPTIONS: InternalSupportResistanceOptions = {
  clusterThreshold: 0.01,
  minTouches: 2,
  maxLevelsPerSide: 1,
  touchWeight: 30,
  bounceWeight: 300,
  extremityWeight: 0.5,
  lookback: 1,
  tiers: [],
  tierLookbacks: {},
  recencyHalfLife: 50,
  volumeWeight: 0.3,
};

const SUPPORT_RESISTANCE_EVENT_DEFINITIONS = {
  SUPPORT_LEVEL_IDENTIFIED: {
    id: 'supportResistance.support.level',
    name: 'Support Level Identified',
    description: 'A horizontal support level met the clustering and scoring criteria.',
  },
  RESISTANCE_LEVEL_IDENTIFIED: {
    id: 'supportResistance.resistance.level',
    name: 'Resistance Level Identified',
    description: 'A horizontal resistance level met the clustering and scoring criteria.',
  },
  PRICE_NEAR_SR: {
    id: 'price_near_sr',
    name: 'Price Near Support/Resistance',
    description: 'The latest closing price is within the configured threshold of a key level.',
  },
  BREAKOUT: {
    id: 'breakout',
    name: 'Support/Resistance Breakout',
    description: 'Price closed beyond the strongest support or resistance level.',
  },
  // Lifecycle events are defined in supportResistanceTracker.ts (single source of truth)
  // Re-exported via getTrackerEventDefinitions() and included in getEventDefinitions() below.
} as const;

const toFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const resolveTimestamp = (candle: SupportResistanceInputCandle, fallbackIndex: number): number | null => {
  const direct = toFiniteNumber(candle.t ?? candle.timestamp);
  if (direct !== null) {
    return direct;
  }

  const textualSource =
    candle.date ??
    candle.datetime ??
    candle.time;

  if (textualSource !== undefined) {
    const parsed = new Date(textualSource).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (candle.ts && typeof candle.ts === 'number') {
    return candle.ts;
  }

  return Number.isFinite(fallbackIndex) ? fallbackIndex : null;
};

export const normaliseSupportResistanceCandles = (
  candles: SupportResistanceInputCandle[] = [],
): Candle[] => {
  const normalised = candles
    .map((rawCandle, index) => {
      if (!rawCandle) {
        return null;
      }

      const open = toFiniteNumber(rawCandle.o ?? rawCandle.open ?? rawCandle.Open);
      const high = toFiniteNumber(rawCandle.h ?? rawCandle.high ?? rawCandle.High);
      const low = toFiniteNumber(rawCandle.l ?? rawCandle.low ?? rawCandle.Low);
      const close = toFiniteNumber(rawCandle.c ?? rawCandle.close ?? rawCandle.Close);
      if ([open, high, low, close].some((value) => value === null)) {
        return null;
      }

      const timestamp = resolveTimestamp(rawCandle, index);
      if (timestamp === null || !Number.isFinite(timestamp)) {
        return null;
      }

      // Preserve volume if present
      const volume = toFiniteNumber(rawCandle.v);

      return {
        t: timestamp,
        o: open!,
        h: high!,
        l: low!,
        c: close!,
        ...(volume !== null ? { v: volume } : {}),
      } as Candle;
    })
    .filter((candle): candle is Candle => Boolean(candle))
    .sort((a, b) => a.t - b.t);

  return normalised;
};

// --- Internal types for enriched extremes ---

type SwingPointMeta = {
  price: number;
  index: number;
  tier: LevelTier;
  volume?: number;
};

type ExtremesContext = {
  highs: SwingPointMeta[];
  lows: SwingPointMeta[];
};

const identifyExtremes = (candles: Candle[], lookback: number = 3): ExtremesContext => {
  const highs: SwingPointMeta[] = [];
  const lows: SwingPointMeta[] = [];

  const swings = computeSwings(candles, { lookback });

  for (const sh of swings.highs) {
    highs.push({
      price: sh.price,
      index: sh.index,
      tier: 'local', // will be overridden by caller
      volume: candles[sh.index]?.v,
    });
  }

  for (const sl of swings.lows) {
    lows.push({
      price: sl.price,
      index: sl.index,
      tier: 'local',
      volume: candles[sl.index]?.v,
    });
  }

  return { highs, lows };
};

const identifyMultiTierExtremes = (
  candles: Candle[],
  tiers: LevelTier[],
  tierLookbacks: Record<string, number>,
): ExtremesContext => {
  const allHighs: SwingPointMeta[] = [];
  const allLows: SwingPointMeta[] = [];

  // Process tiers from lowest to highest so higher tiers override
  const sortedTiers = [...tiers].sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b]);

  // Track seen indices to deduplicate swing points detected at multiple tiers.
  // A point detected at both local (lookback=3) and structural (lookback=21) should
  // only appear once, promoted to the highest tier.
  const seenHighIndices = new Map<number, number>(); // index → position in allHighs
  const seenLowIndices = new Map<number, number>();  // index → position in allLows

  for (const tier of sortedTiers) {
    const lb = tierLookbacks[tier] ?? DEFAULT_TIER_LOOKBACKS[tier];
    const swings = computeSwings(candles, { lookback: lb });

    for (const sh of swings.highs) {
      const existing = seenHighIndices.get(sh.index);
      if (existing !== undefined) {
        // Promote to higher tier (sortedTiers goes low→high, so later tier wins)
        allHighs[existing].tier = tier;
      } else {
        seenHighIndices.set(sh.index, allHighs.length);
        allHighs.push({
          price: sh.price,
          index: sh.index,
          tier,
          volume: candles[sh.index]?.v,
        });
      }
    }

    for (const sl of swings.lows) {
      const existing = seenLowIndices.get(sl.index);
      if (existing !== undefined) {
        allLows[existing].tier = tier;
      } else {
        seenLowIndices.set(sl.index, allLows.length);
        allLows.push({
          price: sl.price,
          index: sl.index,
          tier,
          volume: candles[sl.index]?.v,
        });
      }
    }
  }

  return { highs: allHighs, lows: allLows };
};

// --- Volume SMA helper ---

const computeVolumeSMA = (candles: Candle[], period: number = 20): number[] => {
  const sma: number[] = Array.from<number>({ length: candles.length }).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].v ?? 0;
    if (i >= period) {
      sum -= candles[i - period].v ?? 0;
      sma[i] = sum / period;
    } else {
      sma[i] = sum / (i + 1);
    }
  }
  return sma;
};

// --- Recency weight ---

const recencyWeight = (touchIndex: number, currentIndex: number, halfLife: number): number => {
  return Math.exp(-0.693 * (currentIndex - touchIndex) / halfLife);
};

// --- Clustering with enriched metadata ---

type EnrichedCluster = {
  level: number;
  count: number;
  touches: number;
  bounce: number;
  min: number;
  max: number;
  maxTier: LevelTier;
  touchIndices: number[];
  touchVolumes: (number | undefined)[];
  touchBounces: number[];
};

const clusterLevels = (
  points: SwingPointMeta[],
  {
    candles,
    options,
    isResistance,
    priceRangeHigh,
    priceRangeLow,
    volumeSMA,
    useTiers,
  }: {
    candles: Candle[];
    options: InternalSupportResistanceOptions;
    isResistance: boolean;
    priceRangeHigh: number;
    priceRangeLow: number;
    volumeSMA: number[];
    useTiers: boolean;
  },
): SupportResistanceLevel[] => {
  if (!points.length) {
    return [];
  }

  const clusters: EnrichedCluster[] = [];
  const threshold = options.clusterThreshold;
  const currentIndex = candles.length - 1;

  // Sort by price for clustering
  const sorted = points.slice().sort((a, b) => a.price - b.price);

  for (const point of sorted) {
    const { price, index, tier, volume } = point;

    // Compute bounce for this point
    let bounce = 0;
    if (price !== 0) {
      if (isResistance) {
        const nextIdx = index + 1;
        if (nextIdx < candles.length) {
          bounce = Math.abs(candles[nextIdx].c - price) / Math.abs(price);
        }
      } else {
        const prevIdx = index - 1;
        if (prevIdx >= 0) {
          bounce = Math.abs(price - candles[prevIdx].c) / Math.abs(price);
        }
      }
    }

    const targetCluster = clusters.find(
      (cluster) => Math.abs(cluster.level - price) / Math.max(price, Number.EPSILON) <= threshold,
    );

    if (!targetCluster) {
      clusters.push({
        level: price,
        count: 1,
        touches: 1,
        bounce,
        min: price,
        max: price,
        maxTier: tier,
        touchIndices: [index],
        touchVolumes: [volume],
        touchBounces: [bounce],
      });
      continue;
    }

    targetCluster.level =
      (targetCluster.level * targetCluster.count + price) / (targetCluster.count + 1);
    targetCluster.count += 1;
    targetCluster.touches += 1;
    targetCluster.bounce += bounce;
    targetCluster.min = Math.min(targetCluster.min, price);
    targetCluster.max = Math.max(targetCluster.max, price);
    targetCluster.touchIndices.push(index);
    targetCluster.touchVolumes.push(volume);
    targetCluster.touchBounces.push(bounce);

    if (TIER_ORDER[tier] > TIER_ORDER[targetCluster.maxTier]) {
      targetCluster.maxTier = tier;
    }
  }

  const priceRange = Math.max(priceRangeHigh - priceRangeLow, Number.EPSILON);
  const hasVolume = candles.some((c) => c.v !== undefined && c.v > 0);

  return clusters
    .map((cluster) => {
      const extremityFactor = isResistance
        ? (cluster.level - priceRangeLow) / priceRange
        : (priceRangeHigh - cluster.level) / priceRange;

      const extremityMultiplier = 1 + Math.max(0, extremityFactor) * options.extremityWeight;

      // Recency score: weighted average of recency weights for each touch
      let recencyScore = 0;
      if (cluster.touchIndices.length > 0) {
        let totalRecency = 0;
        for (const idx of cluster.touchIndices) {
          totalRecency += recencyWeight(idx, currentIndex, options.recencyHalfLife);
        }
        recencyScore = totalRecency / cluster.touchIndices.length;
      }

      // Volume score
      let volumeScore = 0;
      if (hasVolume) {
        let volSum = 0;
        let volCount = 0;
        for (let i = 0; i < cluster.touchVolumes.length; i++) {
          const vol = cluster.touchVolumes[i];
          const idx = cluster.touchIndices[i];
          if (vol !== undefined && vol > 0 && volumeSMA[idx] > 0) {
            volSum += vol / volumeSMA[idx];
            volCount++;
          }
        }
        if (volCount > 0) {
          volumeScore = volSum / volCount;
        }
      }

      // Tier bonus
      const tierBonus = useTiers ? TIER_BONUS[cluster.maxTier] : 1.0;

      // Bounce strength (average)
      const avgBounce = cluster.touchBounces.length > 0
        ? cluster.touchBounces.reduce((s, b) => s + b, 0) / cluster.touchBounces.length
        : 0;

      // Composite scoring
      const touchesScore = cluster.touches * options.touchWeight;
      const bounceScore = cluster.bounce * options.bounceWeight;
      const baseScore = (touchesScore + bounceScore) * extremityMultiplier;

      // Enhanced overall: base * tierBonus * (1 + recency) * (1 + volumeWeight * volumeScore)
      const overall = baseScore * tierBonus * (1 + recencyScore) * (1 + options.volumeWeight * volumeScore);

      const roundedLevel = Number(cluster.level.toFixed(4));

      const level: SupportResistanceLevel = {
        level: roundedLevel,
        touches: cluster.touches,
        bounce: cluster.bounce,
        bounceStrength: avgBounce,
        score: overall,
        count: cluster.count,
        extremityFactor,
        extremityMultiplier,
        zone: {
          center: roundedLevel,
          upper: Number(cluster.max.toFixed(4)),
          lower: Number(cluster.min.toFixed(4)),
        },
        strength: {
          touchCount: cluster.touches,
          bounceStrength: avgBounce,
          volumeScore,
          recencyScore,
          tierBonus,
          overall,
        },
      };

      if (useTiers) {
        level.tier = cluster.maxTier;
      }

      return level;
    })
    .sort((a, b) => b.score - a.score);
};

export const detectSupportResistance = (
  rawCandles: SupportResistanceInputCandle[] = [],
  options: SupportResistanceOptions = {},
): SupportResistanceResult => {
  const candles = normaliseSupportResistanceCandles(rawCandles);
  const useTiers = Boolean(options.tiers && options.tiers.length > 0);

  const resolved: InternalSupportResistanceOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    maxLevelsPerSide:
      options.maxLevelsPerSide && options.maxLevelsPerSide > 0
        ? options.maxLevelsPerSide
        : DEFAULT_OPTIONS.maxLevelsPerSide,
    lookback: options.lookback ?? DEFAULT_OPTIONS.lookback,
    tiers: options.tiers ?? DEFAULT_OPTIONS.tiers,
    tierLookbacks: { ...DEFAULT_TIER_LOOKBACKS, ...options.tierLookbacks },
    recencyHalfLife: options.recencyHalfLife ?? DEFAULT_OPTIONS.recencyHalfLife,
    volumeWeight: options.volumeWeight ?? DEFAULT_OPTIONS.volumeWeight,
  };

  if (candles.length < 3) {
    return {
      support: [],
      resistance: [],
      priceRangeHigh: 0,
      priceRangeLow: 0,
      sourceLength: candles.length,
    };
  }

  const priceRangeHigh = candles.reduce((max, candle) => Math.max(max, candle.h), -Infinity);
  const priceRangeLow = candles.reduce((min, candle) => Math.min(min, candle.l), Infinity);

  let extremes: ExtremesContext;
  if (useTiers) {
    extremes = identifyMultiTierExtremes(candles, resolved.tiers, resolved.tierLookbacks);
  } else {
    extremes = identifyExtremes(candles, resolved.lookback);
  }

  const volumeSMA = computeVolumeSMA(candles);

  const supportRaw = clusterLevels(extremes.lows, {
    candles,
    options: resolved,
    isResistance: false,
    priceRangeHigh,
    priceRangeLow,
    volumeSMA,
    useTiers,
  });

  const resistanceRaw = clusterLevels(extremes.highs, {
    candles,
    options: resolved,
    isResistance: true,
    priceRangeHigh,
    priceRangeLow,
    volumeSMA,
    useTiers,
  });

  const filterByTouches = (level: SupportResistanceLevel) => level.touches >= resolved.minTouches;
  const clamp = (levels: SupportResistanceLevel[]) =>
    resolved.maxLevelsPerSide === Infinity
      ? levels
      : levels.slice(0, resolved.maxLevelsPerSide);

  const assignSideAndId = (levels: SupportResistanceLevel[], side: 'support' | 'resistance') =>
    levels.map((l) => ({
      ...l,
      side,
      id: `sr_${side}_${l.level.toFixed(4)}`,
    }));

  return {
    support: assignSideAndId(clamp(supportRaw.filter(filterByTouches)), 'support'),
    resistance: assignSideAndId(clamp(resistanceRaw.filter(filterByTouches)), 'resistance'),
    priceRangeHigh,
    priceRangeLow,
    sourceLength: candles.length,
  };
};

export type SupportResistanceEventPayload = SupportResistanceLevel & {
  side: 'support' | 'resistance';
  priceRangeHigh: number;
  priceRangeLow: number;
};

export type PriceNearEventPayload = {
  levelType: 'support' | 'resistance';
  level: number;
  closingPrice: number;
  distanceFromLevel: number;
  movementDirection: 'approaching_from_above' | 'approaching_from_below';
};

export type BreakoutEventPayload = {
  breakoutDirection: 'bullish' | 'bearish';
  breakoutLevel: number;
  closingPrice: number;
  previousClose: number;
  confidenceScore: number;
};

export const getEventDefinitions = () => [
  ...Object.values(SUPPORT_RESISTANCE_EVENT_DEFINITIONS),
  ...getTrackerEventDefinitions(),
];

export const detectEvents = (
  rawCandles: SupportResistanceInputCandle[] = [],
  options?: SupportResistanceEventOptions,
): IndicatorEvent<
  SupportResistanceEventPayload | PriceNearEventPayload | BreakoutEventPayload
>[] => {
  const { priceNearThresholdPct = 2, ...levelOptionsRaw } = options ?? {};
  const levelOptions = levelOptionsRaw as SupportResistanceOptions;
  const result = detectSupportResistance(rawCandles, levelOptions);
  const candles = normaliseSupportResistanceCandles(rawCandles);
  if (!candles.length) {
    return [];
  }

  const lastIndex = candles.length - 1;
  const referenceCandle = candles[lastIndex];
  const events: IndicatorEvent<
    SupportResistanceEventPayload | PriceNearEventPayload | BreakoutEventPayload
  >[] = [];

  result.support.forEach((level) => {
    events.push(
      createIndicatorEvent(SUPPORT_RESISTANCE_EVENT_DEFINITIONS.SUPPORT_LEVEL_IDENTIFIED, {
        candle: referenceCandle,
        index: lastIndex,
        payload: {
          ...level,
          side: 'support',
          priceRangeHigh: result.priceRangeHigh,
          priceRangeLow: result.priceRangeLow,
        },
      }),
    );
  });

  result.resistance.forEach((level) => {
    events.push(
      createIndicatorEvent(SUPPORT_RESISTANCE_EVENT_DEFINITIONS.RESISTANCE_LEVEL_IDENTIFIED, {
        candle: referenceCandle,
        index: lastIndex,
        payload: {
          ...level,
          side: 'resistance',
          priceRangeHigh: result.priceRangeHigh,
          priceRangeLow: result.priceRangeLow,
        },
      }),
    );
  });

  const strongestSupport = result.support.at(0);
  const strongestResistance = result.resistance.at(0);
  const lastCandle = candles.at(-1);
  const previousCandle = candles.at(-2);

  if (lastCandle) {
    const threshold = lastCandle.c * (priceNearThresholdPct / 100);

    if (strongestSupport && Math.abs(lastCandle.c - strongestSupport.level) <= threshold) {
      events.push(
        createIndicatorEvent(SUPPORT_RESISTANCE_EVENT_DEFINITIONS.PRICE_NEAR_SR, {
          candle: lastCandle,
          index: candles.length - 1,
          payload: {
            levelType: 'support',
            level: strongestSupport.level,
            closingPrice: lastCandle.c,
            distanceFromLevel: Math.abs(lastCandle.c - strongestSupport.level),
            movementDirection:
              lastCandle.c > strongestSupport.level ? 'approaching_from_above' : 'approaching_from_below',
          },
        }),
      );
    }

    if (strongestResistance && Math.abs(lastCandle.c - strongestResistance.level) <= threshold) {
      events.push(
        createIndicatorEvent(SUPPORT_RESISTANCE_EVENT_DEFINITIONS.PRICE_NEAR_SR, {
          candle: lastCandle,
          index: candles.length - 1,
          payload: {
            levelType: 'resistance',
            level: strongestResistance.level,
            closingPrice: lastCandle.c,
            distanceFromLevel: Math.abs(lastCandle.c - strongestResistance.level),
            movementDirection:
              lastCandle.c > strongestResistance.level ? 'approaching_from_below' : 'approaching_from_above',
          },
        }),
      );
    }
  }

  if (lastCandle && previousCandle && strongestSupport && strongestResistance) {
    const prevClose = previousCandle.c;
    const close = lastCandle.c;

    if (prevClose <= strongestResistance.level && close > strongestResistance.level) {
      events.push(
        createIndicatorEvent(SUPPORT_RESISTANCE_EVENT_DEFINITIONS.BREAKOUT, {
          candle: lastCandle,
          index: candles.length - 1,
          payload: {
            breakoutDirection: 'bullish',
            breakoutLevel: strongestResistance.level,
            closingPrice: close,
            previousClose: prevClose,
            confidenceScore: Number((strongestResistance.score / 100).toFixed(2)),
          },
        }),
      );
    }

    if (prevClose >= strongestSupport.level && close < strongestSupport.level) {
      events.push(
        createIndicatorEvent(SUPPORT_RESISTANCE_EVENT_DEFINITIONS.BREAKOUT, {
          candle: lastCandle,
          index: candles.length - 1,
          payload: {
            breakoutDirection: 'bearish',
            breakoutLevel: strongestSupport.level,
            closingPrice: close,
            previousClose: prevClose,
            confidenceScore: Number((strongestSupport.score / 100).toFixed(2)),
          },
        }),
      );
    }
  }

  return events;
};
