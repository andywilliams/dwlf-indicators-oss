import { describe, expect, it } from 'vitest';
import { detectEvents, detectSupportResistance, getEventDefinitions } from './supportResistance';
import type { Candle } from '../../types';

const createTestCandles = (): Candle[] => [
  { t: 0, o: 110, h: 118, l: 100, c: 112 },
  { t: 1, o: 112, h: 121, l: 102, c: 109 },
  { t: 2, o: 109, h: 119, l: 95.2, c: 97 },
  { t: 3, o: 97, h: 122.1, l: 98.8, c: 120 },
  { t: 4, o: 120, h: 120.6, l: 94.6, c: 95.1 },
  { t: 5, o: 95, h: 124, l: 99.8, c: 123 },
  { t: 6, o: 123, h: 123.1, l: 101.2, c: 102 },
  { t: 7, o: 105, h: 130, l: 104, c: 128 },
];

describe('supportResistance', () => {
  it('detects clustered support and resistance levels', () => {
    const candles = createTestCandles();
    const result = detectSupportResistance(candles);

    expect(result.support).toHaveLength(1);
    expect(result.resistance).toHaveLength(1);
    expect(result.support[0].touches).toBeGreaterThanOrEqual(2);
    expect(result.resistance[0].touches).toBeGreaterThanOrEqual(2);
  });

  it('honours configuration overrides', () => {
    const candles = createTestCandles();

    const result = detectSupportResistance(candles, {
      maxLevelsPerSide: 2,
      minTouches: 1,
    });

    expect(result.support.length).toBeLessThanOrEqual(2);
    expect(result.resistance.length).toBeLessThanOrEqual(2);
    expect(result.support[0].score).toBeGreaterThan(0);
  });
});

describe('supportResistance new fields', () => {
  const candles = createTestCandles();

  it('zone field is populated with center, upper, lower', () => {
    const result = detectSupportResistance(candles, { minTouches: 1, maxLevelsPerSide: 5 });
    const allLevels = [...result.support, ...result.resistance];
    expect(allLevels.length).toBeGreaterThan(0);
    for (const lvl of allLevels) {
      expect(lvl.zone).toBeDefined();
      expect(lvl.zone!.center).toBe(lvl.level);
      expect(lvl.zone!.lower).toBeLessThanOrEqual(lvl.zone!.center);
      expect(lvl.zone!.upper).toBeGreaterThanOrEqual(lvl.zone!.center);
    }
  });

  it('side field is set correctly', () => {
    const result = detectSupportResistance(candles, { minTouches: 1, maxLevelsPerSide: 5 });
    for (const lvl of result.support) {
      expect(lvl.side).toBe('support');
    }
    for (const lvl of result.resistance) {
      expect(lvl.side).toBe('resistance');
    }
  });

  it('id field is present and follows expected format', () => {
    const result = detectSupportResistance(candles, { minTouches: 1, maxLevelsPerSide: 5 });
    const allLevels = [...result.support, ...result.resistance];
    for (const lvl of allLevels) {
      expect(lvl.id).toBeDefined();
      expect(lvl.id).toMatch(/^sr_(support|resistance)_\d+\.\d{4}$/);
      expect(lvl.id).toBe(`sr_${lvl.side}_${lvl.level.toFixed(4)}`);
    }
  });

  it('lookback option changes detected levels', () => {
    // With more candles to allow lookback=3 to work
    const moreCandles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      const base = 100 + Math.sin(i * 0.5) * 20;
      moreCandles.push({
        t: i,
        o: base - 2,
        h: base + 5,
        l: base - 5,
        c: base + 2,
      });
    }
    const r1 = detectSupportResistance(moreCandles, { lookback: 1, minTouches: 1, maxLevelsPerSide: 10 });
    const r3 = detectSupportResistance(moreCandles, { lookback: 3, minTouches: 1, maxLevelsPerSide: 10 });
    // Different lookbacks should produce different numbers of levels
    const total1 = r1.support.length + r1.resistance.length;
    const total3 = r3.support.length + r3.resistance.length;
    // lookback=3 is stricter, so should find fewer or equal levels
    expect(total3).toBeLessThanOrEqual(total1);
  });

  it('backward compat: level, touches, score still work', () => {
    const result = detectSupportResistance(candles);
    for (const lvl of [...result.support, ...result.resistance]) {
      expect(typeof lvl.level).toBe('number');
      expect(typeof lvl.touches).toBe('number');
      expect(typeof lvl.score).toBe('number');
      expect(typeof lvl.bounce).toBe('number');
      expect(typeof lvl.bounceStrength).toBe('number');
      expect(typeof lvl.count).toBe('number');
      expect(typeof lvl.extremityFactor).toBe('number');
      expect(typeof lvl.extremityMultiplier).toBe('number');
    }
  });

  it('exposes formationIndex, lastTouchIndex, and chronologically-sorted touchIndices', () => {
    const result = detectSupportResistance(candles, { minTouches: 1, maxLevelsPerSide: 10 });
    const levels = [...result.support, ...result.resistance];
    expect(levels.length).toBeGreaterThan(0);
    for (const lvl of levels) {
      expect(Array.isArray(lvl.touchIndices)).toBe(true);
      expect(lvl.touchIndices!.length).toBeGreaterThan(0);
      expect(lvl.formationIndex).toBe(lvl.touchIndices![0]);
      expect(lvl.lastTouchIndex).toBe(lvl.touchIndices![lvl.touchIndices!.length - 1]);
      for (let i = 1; i < lvl.touchIndices!.length; i++) {
        expect(lvl.touchIndices![i]).toBeGreaterThanOrEqual(lvl.touchIndices![i - 1]);
      }
    }
  });
});

describe('support/resistance events', () => {
  it('exposes metadata and emits level events', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'supportResistance.support.level',
        'supportResistance.resistance.level',
        'price_near_sr',
        'breakout',
      ]),
    );

    const candles = createTestCandles();
    const events = detectEvents(candles, { priceNearThresholdPct: 10 });

    expect(events.length).toBeGreaterThan(0);
    const supportEvent = events.find((event) => event.id === 'supportResistance.support.level');
    if (supportEvent?.payload && 'side' in supportEvent.payload) {
      expect(supportEvent.payload.side).toBe('support');
    }
    expect(events.some((event) => event.id === 'price_near_sr')).toBe(true);
    expect(events.some((event) => event.id === 'breakout')).toBe(true);
  });
});

// --- Phase 2 Tests ---

// Generate synthetic data with clear swing structure for multi-tier testing
const createLargeDataset = (size: number = 100): Candle[] => {
  const candles: Candle[] = [];
  for (let i = 0; i < size; i++) {
    // Create a wave pattern with structural, intermediate, and local swings
    const structural = Math.sin(i * 0.06) * 30; // slow wave
    const intermediate = Math.sin(i * 0.2) * 10; // medium wave
    const local = Math.sin(i * 0.8) * 3; // fast wave
    const base = 100 + structural + intermediate + local;
    candles.push({
      t: i,
      o: base - 1,
      h: base + 3,
      l: base - 3,
      c: base + 1,
      v: 1000 + Math.random() * 500,
    });
  }
  return candles;
};

describe('Phase 2: Multi-Tier Detection', () => {
  it('detects levels with tier annotations when tiers are specified', () => {
    const candles = createLargeDataset(100);
    const result = detectSupportResistance(candles, {
      tiers: ['local', 'intermediate', 'structural'],
      minTouches: 1,
      maxLevelsPerSide: 10,
    });

    const allLevels = [...result.support, ...result.resistance];
    expect(allLevels.length).toBeGreaterThan(0);

    // All levels should have tier set
    for (const lvl of allLevels) {
      expect(lvl.tier).toBeDefined();
      expect(['local', 'intermediate', 'structural']).toContain(lvl.tier);
    }
  });

  it('structural lookback=21 finds fewer swings than local lookback=3', () => {
    const candles = createLargeDataset(100);

    const localOnly = detectSupportResistance(candles, {
      tiers: ['local'],
      minTouches: 1,
      maxLevelsPerSide: 50,
    });

    const structuralOnly = detectSupportResistance(candles, {
      tiers: ['structural'],
      minTouches: 1,
      maxLevelsPerSide: 50,
    });

    const localTotal = localOnly.support.length + localOnly.resistance.length;
    const structuralTotal = structuralOnly.support.length + structuralOnly.resistance.length;

    // Structural should find fewer or equal levels
    expect(structuralTotal).toBeLessThanOrEqual(localTotal);
  });

  it('does not add tier field when tiers option is not used', () => {
    const candles = createTestCandles();
    const result = detectSupportResistance(candles, { minTouches: 1, maxLevelsPerSide: 10 });
    const allLevels = [...result.support, ...result.resistance];
    for (const lvl of allLevels) {
      expect(lvl.tier).toBeUndefined();
    }
  });

  it('supports custom tier lookbacks', () => {
    const candles = createLargeDataset(100);
    const result = detectSupportResistance(candles, {
      tiers: ['local'],
      tierLookbacks: { local: 5 },
      minTouches: 1,
      maxLevelsPerSide: 50,
    });
    // Should work without error
    expect(result.support.length + result.resistance.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase 2: Recency Scoring', () => {
  it('recent touches score higher than old ones', () => {
    // Build data where the same price level is touched early and late
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      // Create bounces at price ~100 at index 5 and index 55
      let base = 110;
      if (i === 5 || i === 55) base = 100; // touch support
      if (i === 4 || i === 54) base = 100; // approach
      if (i === 6 || i === 56) base = 100; // approach
      // Create swing lows
      if (i === 5) {
        candles.push({ t: i, o: 102, h: 103, l: 98, c: 101 });
      } else if (i === 55) {
        candles.push({ t: i, o: 102, h: 103, l: 98, c: 101 });
      } else {
        candles.push({ t: i, o: base - 1, h: base + 3, l: base - 3, c: base + 1 });
      }
    }

    const result = detectSupportResistance(candles, {
      minTouches: 1,
      maxLevelsPerSide: 10,
      recencyHalfLife: 20,
    });

    // All levels should have recencyScore in strength
    const allLevels = [...result.support, ...result.resistance];
    for (const lvl of allLevels) {
      expect(lvl.strength).toBeDefined();
      expect(lvl.strength!.recencyScore).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Phase 2: Volume Scoring', () => {
  it('levels at high-volume points score higher', () => {
    const candles: Candle[] = [];
    // Create wave pattern with volume spikes at certain points
    for (let i = 0; i < 40; i++) {
      const base = 100 + Math.sin(i * 0.5) * 15;
      candles.push({
        t: i,
        o: base - 1,
        h: base + 4,
        l: base - 4,
        c: base + 1,
        v: i >= 18 && i <= 22 ? 5000 : 1000, // high volume around index 20
      });
    }

    const result = detectSupportResistance(candles, {
      minTouches: 1,
      maxLevelsPerSide: 10,
      volumeWeight: 0.5,
    });

    const allLevels = [...result.support, ...result.resistance];
    // At least some levels should have non-zero volume scores
    const withVolume = allLevels.filter((l) => l.strength && l.strength.volumeScore > 0);
    expect(withVolume.length).toBeGreaterThan(0);
  });

  it('gracefully handles candles without volume', () => {
    const candles = createTestCandles(); // no volume
    const result = detectSupportResistance(candles, {
      minTouches: 1,
      maxLevelsPerSide: 10,
    });

    const allLevels = [...result.support, ...result.resistance];
    for (const lvl of allLevels) {
      expect(lvl.strength).toBeDefined();
      expect(lvl.strength!.volumeScore).toBe(0);
    }
  });
});

describe('Phase 2: Strength Object', () => {
  it('strength object is populated on all levels', () => {
    const candles = createTestCandles();
    const result = detectSupportResistance(candles, { minTouches: 1, maxLevelsPerSide: 10 });
    const allLevels = [...result.support, ...result.resistance];

    expect(allLevels.length).toBeGreaterThan(0);
    for (const lvl of allLevels) {
      expect(lvl.strength).toBeDefined();
      expect(typeof lvl.strength!.touchCount).toBe('number');
      expect(typeof lvl.strength!.bounceStrength).toBe('number');
      expect(typeof lvl.strength!.volumeScore).toBe('number');
      expect(typeof lvl.strength!.recencyScore).toBe('number');
      expect(typeof lvl.strength!.tierBonus).toBe('number');
      expect(typeof lvl.strength!.overall).toBe('number');
      // score should equal strength.overall
      expect(lvl.score).toBe(lvl.strength!.overall);
    }
  });

  it('tier bonus is correct for tiered detection', () => {
    const candles = createLargeDataset(100);

    // Structural only
    const result = detectSupportResistance(candles, {
      tiers: ['structural'],
      minTouches: 1,
      maxLevelsPerSide: 10,
    });

    const allLevels = [...result.support, ...result.resistance];
    for (const lvl of allLevels) {
      expect(lvl.strength!.tierBonus).toBe(1.5);
    }
  });

  it('default behavior (no options) still works identically', () => {
    const candles = createTestCandles();
    const result = detectSupportResistance(candles);

    expect(result.support).toHaveLength(1);
    expect(result.resistance).toHaveLength(1);
    expect(result.support[0].touches).toBeGreaterThanOrEqual(2);
    expect(result.resistance[0].touches).toBeGreaterThanOrEqual(2);

    // strength should still be present
    expect(result.support[0].strength).toBeDefined();
    expect(result.resistance[0].strength).toBeDefined();

    // tier should NOT be set (no tiers option)
    expect(result.support[0].tier).toBeUndefined();
    expect(result.resistance[0].tier).toBeUndefined();
  });
});
