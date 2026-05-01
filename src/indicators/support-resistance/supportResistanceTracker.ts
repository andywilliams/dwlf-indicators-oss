import type { Candle, IndicatorEvent } from '../../types';
import { createIndicatorEvent } from '../../utils/events';
import {
  detectSupportResistance,
  type SupportResistanceLevel,
  type SupportResistanceOptions,
  type SupportResistanceResult,
} from './supportResistance';

// --- Lifecycle event definitions ---

const TRACKER_EVENT_DEFINITIONS = {
  LEVEL_BROKEN: {
    id: 'supportResistance.level.broken',
    name: 'S/R Level Broken',
    description: 'Price closed decisively beyond a tracked support/resistance level.',
  },
  LEVEL_FLIPPED: {
    id: 'supportResistance.level.flipped',
    name: 'S/R Level Flipped',
    description: 'A broken level confirmed in the opposite role (polarity flip).',
  },
  LEVEL_EXPIRED: {
    id: 'supportResistance.level.expired',
    name: 'S/R Level Expired',
    description: 'A level was retired after no price interaction for the configured expiry period.',
  },
  LEVEL_RETEST: {
    id: 'supportResistance.level.retest',
    name: 'S/R Level Retest',
    description: 'Price returned to a known support/resistance zone.',
  },
} as const;

export const getTrackerEventDefinitions = () => Object.values(TRACKER_EVENT_DEFINITIONS);

// --- Types ---

export type LevelState = 'active' | 'tested' | 'broken' | 'flipped' | 'expired';

export type LevelHistory = {
  originalSide: 'support' | 'resistance';
  breakIndex?: number;
  flipCount: number;
};

export type TrackedLevel = SupportResistanceLevel & {
  state: LevelState;
  history?: LevelHistory;
  lastInteractionIndex: number;
};

export type TrackerOptions = SupportResistanceOptions & {
  breakThresholdAtrMultiple?: number;
  expiryBars?: number;
  redetectInterval?: number;
  atrPeriod?: number;
};

// --- ATR helper ---

const computeATR = (candles: Candle[], period: number): number => {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    trs.push(tr);
  }
  if (trs.length === 0) return 0;
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
};

// --- Tracker class ---

export class SupportResistanceTracker {
  private candles: Candle[] = [];
  private levels: TrackedLevel[] = [];
  private candleIndex = 0;
  private opts: Required<Pick<TrackerOptions, 'breakThresholdAtrMultiple' | 'expiryBars' | 'redetectInterval' | 'atrPeriod'>> & SupportResistanceOptions;

  constructor(options?: TrackerOptions) {
    // Use nullish coalescing for each tracker option to avoid undefined overriding defaults
    const { breakThresholdAtrMultiple, expiryBars, redetectInterval, atrPeriod, ...srOptions } = options ?? {};
    // Filter out undefined values from srOptions
    const cleanSrOptions: SupportResistanceOptions = {};
    for (const [key, value] of Object.entries(srOptions)) {
      if (value !== undefined) {
        (cleanSrOptions as Record<string, unknown>)[key] = value;
      }
    }
    this.opts = {
      breakThresholdAtrMultiple: breakThresholdAtrMultiple ?? 0.5,
      expiryBars: expiryBars ?? 100,
      redetectInterval: redetectInterval && redetectInterval > 0 ? redetectInterval : 10,
      atrPeriod: atrPeriod ?? 14,
      ...cleanSrOptions,
    };
  }

  update(candle: Candle): IndicatorEvent[] {
    this.candles.push(candle);
    this.candleIndex = this.candles.length - 1;
    const events: IndicatorEvent[] = [];

    // Periodically re-detect levels
    if (this.candles.length >= 3 && this.candles.length % this.opts.redetectInterval === 0) {
      this.redetectLevels();
    }

    // Process lifecycle for existing levels
    const atr = computeATR(this.candles, this.opts.atrPeriod);
    const close = candle.c;

    for (const level of this.levels) {
      if (level.state === 'expired') continue;

      const zone = level.zone!;
      const side = level.side!;
      const inZone = close >= zone.lower && close <= zone.upper;

      // Flipped levels transition to active on the next candle
      if (level.state === 'flipped') {
        level.state = 'active';
      }

      if (level.state === 'active') {
        // Check expiry
        if (this.candleIndex - level.lastInteractionIndex > this.opts.expiryBars) {
          level.state = 'expired';
          events.push(this.createEvent(TRACKER_EVENT_DEFINITIONS.LEVEL_EXPIRED, candle, level));
          continue;
        }
        // Check for gap-through-zone: price closed decisively beyond without entering zone
        if (!inZone && this.isDecisiveBreak(close, level, atr, side)) {
          level.state = 'broken';
          level.lastInteractionIndex = this.candleIndex;
          level.history = {
            originalSide: level.history?.originalSide ?? side,
            breakIndex: this.candleIndex,
            flipCount: level.history?.flipCount ?? 0,
          };
          events.push(this.createEvent(TRACKER_EVENT_DEFINITIONS.LEVEL_BROKEN, candle, level));
          continue;
        }
        // Check if price enters zone
        if (inZone) {
          level.state = 'tested';
          level.lastInteractionIndex = this.candleIndex;
          events.push(this.createEvent(TRACKER_EVENT_DEFINITIONS.LEVEL_RETEST, candle, level));
        }
      } else if (level.state === 'tested') {
        level.lastInteractionIndex = this.candleIndex;
        // Check for decisive break
        if (this.isDecisiveBreak(close, level, atr, side)) {
          level.state = 'broken';
          level.history = {
            originalSide: level.history?.originalSide ?? side,
            breakIndex: this.candleIndex,
            flipCount: level.history?.flipCount ?? 0,
          };
          events.push(this.createEvent(TRACKER_EVENT_DEFINITIONS.LEVEL_BROKEN, candle, level));
        } else if (!inZone) {
          // Only count as a bounce if price exited in the correct direction
          // Support: bounce = price exited upward (close > zone.upper)
          // Resistance: bounce = price exited downward (close < zone.lower)
          const bouncedCorrectly = side === 'support'
            ? close > zone.upper
            : close < zone.lower;

          level.state = 'active';
          if (bouncedCorrectly) {
            level.touches += 1;
            if (level.strength) {
              level.strength.touchCount = level.touches;
            }
          }
        }
      } else if (level.state === 'broken') {
        // Check expiry for broken levels too
        if (this.candleIndex - level.lastInteractionIndex > this.opts.expiryBars) {
          level.state = 'expired';
          events.push(this.createEvent(TRACKER_EVENT_DEFINITIONS.LEVEL_EXPIRED, candle, level));
          continue;
        }
        // Check for retest from opposite side (role reversal)
        if (inZone) {
          level.lastInteractionIndex = this.candleIndex;
          // Price is retesting from opposite side - check for rejection next candle
          // For simplicity: if price is in zone and moving away from break direction, flip
          const flipped = this.checkFlip(close, level, side);
          if (flipped) {
            const newSide: 'support' | 'resistance' = side === 'support' ? 'resistance' : 'support';
            level.side = newSide;
            level.id = `sr_${newSide}_${level.level.toFixed(4)}`;
            level.state = 'flipped';
            level.history = {
              originalSide: level.history?.originalSide ?? side,
              breakIndex: level.history?.breakIndex,
              flipCount: (level.history?.flipCount ?? 0) + 1,
            };
            events.push(this.createEvent(TRACKER_EVENT_DEFINITIONS.LEVEL_FLIPPED, candle, level));
          }
        }
      }
      // 'flipped' state transitions to 'active' at the start of the next candle's processing
    }

    return events;
  }

  getActiveLevels(): TrackedLevel[] {
    return this.levels.filter(l => l.state === 'active' || l.state === 'tested');
  }

  getAllLevels(): TrackedLevel[] {
    return [...this.levels];
  }

  snapshot(): SupportResistanceResult {
    const active = this.getActiveLevels();
    const support = active.filter(l => l.side === 'support');
    const resistance = active.filter(l => l.side === 'resistance');

    let priceRangeHigh = 0;
    let priceRangeLow = 0;
    if (this.candles.length > 0) {
      priceRangeHigh = this.candles.reduce((max, c) => Math.max(max, c.h), -Infinity);
      priceRangeLow = this.candles.reduce((min, c) => Math.min(min, c.l), Infinity);
    }

    return {
      support,
      resistance,
      priceRangeHigh,
      priceRangeLow,
      sourceLength: this.candles.length,
    };
  }

  reset(): void {
    this.candles = [];
    this.levels = [];
    this.candleIndex = 0;
  }

  // --- Private ---

  private redetectLevels(): void {
    const srOptions: SupportResistanceOptions = { ...this.opts };
    // Use higher maxLevelsPerSide for tracking
    srOptions.maxLevelsPerSide = srOptions.maxLevelsPerSide ?? 5;
    const result = detectSupportResistance(this.candles, srOptions);

    const allDetected = [
      ...result.support.map(l => ({ ...l, side: 'support' as const })),
      ...result.resistance.map(l => ({ ...l, side: 'resistance' as const })),
    ];

    // Merge with existing tracked levels
    for (const detected of allDetected) {
      const existing = this.findMatchingLevel(detected);
      if (existing) {
        // Update score/strength but preserve lifecycle state, history, and accumulated touches
        existing.score = Math.max(existing.score, detected.score);
        // Preserve tracker-accumulated touches: take the max to avoid losing tracked interactions
        existing.touches = Math.max(existing.touches, detected.touches);
        existing.bounce = detected.bounce;
        existing.bounceStrength = detected.bounceStrength;
        existing.zone = detected.zone;
        // Merge strength: preserve touch count from tracker
        if (detected.strength) {
          existing.strength = {
            ...detected.strength,
            touchCount: Math.max(existing.strength?.touchCount ?? 0, detected.strength.touchCount),
          };
        }
      } else {
        // New level
        this.levels.push({
          ...detected,
          state: 'active',
          lastInteractionIndex: this.candleIndex,
        } as TrackedLevel);
      }
    }
  }

  private findMatchingLevel(detected: SupportResistanceLevel): TrackedLevel | undefined {
    const zone = detected.zone;
    if (!zone) return undefined;
    return this.levels.find(l => {
      if (l.state === 'expired') return false;
      const lZone = l.zone;
      if (!lZone) return false;
      const centersMatch = Math.abs(lZone.center - zone.center) / Math.max(zone.center, 1e-10) < 0.01;
      if (!centersMatch) return false;
      // Match same side, OR a flipped/broken level at the same zone (prevents duplicates
      // when redetection finds the original side at the same price as a flipped level)
      if (l.side === detected.side) return true;
      // Also match if the level was flipped or broken — it occupies the same zone
      if (l.state === 'broken' || l.state === 'flipped' || l.history?.flipCount) return true;
      return false;
    });
  }

  private isDecisiveBreak(close: number, level: TrackedLevel, atr: number, side: string): boolean {
    const threshold = atr * this.opts.breakThresholdAtrMultiple;
    const zone = level.zone!;
    if (side === 'support') return close < zone.lower - threshold;
    return close > zone.upper + threshold;
  }

  private checkFlip(close: number, level: TrackedLevel, originalSide: string): boolean {
    // A broken support → potential resistance: price enters zone from above, rejected downward
    // Confirm rejection by checking close is below zone center
    // A broken resistance → potential support: price enters zone from below, rejected upward
    // Confirm rejection by checking close is above zone center
    const zoneCenter = level.zone!.center;
    if (originalSide === 'support') {
      // Broken support becoming resistance: close should be below zone center (rejection downward)
      return close < zoneCenter;
    } else {
      // Broken resistance becoming support: close should be above zone center (rejection upward)
      return close > zoneCenter;
    }
  }

  private createEvent(
    definition: typeof TRACKER_EVENT_DEFINITIONS[keyof typeof TRACKER_EVENT_DEFINITIONS],
    candle: Candle,
    level: TrackedLevel,
  ): IndicatorEvent {
    return createIndicatorEvent(definition, {
      candle,
      index: this.candleIndex,
      payload: {
        level: level.level,
        side: level.side,
        state: level.state,
        zone: level.zone,
        history: level.history,
        touches: level.touches,
        score: level.score,
      },
    });
  }
}
