import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeBollingerBands, detectEvents, getEventDefinitions } from './bollinger';
import type { BollingerReentryPayload, BollingerSqueezePayload } from './bollinger';

describe('computeBollingerBands', () => {
  it('computes Bollinger Bands with an SMA basis by default', () => {
    const result = computeBollingerBands(smallCandles, { length: 3, standardDeviation: 2 });

    expect(result.params).toEqual({
      length: 3,
      basis: 'sma',
      source: 'close',
      standardDeviation: 2,
      offset: 0,
    });

    expect(result.middle).toHaveLength(smallCandles.length - 3 + 1);
    expect(result.upper).toHaveLength(result.middle.length);
    expect(result.lower).toHaveLength(result.middle.length);

    const firstMiddle = result.middle.at(0);
    const firstUpper = result.upper.at(0);
    const firstLower = result.lower.at(0);

    expect(firstMiddle?.t).toBe(smallCandles[2].t);
    expect(firstMiddle?.v).toBeCloseTo(102, 10);
    expect(firstUpper?.v).toBeCloseTo(103.6329931619, 10);
    expect(firstLower?.v).toBeCloseTo(100.3670068381, 10);
  });

  it('supports EMA basis, alternative sources, and offsetting', () => {
    const result = computeBollingerBands(smallCandles, {
      length: 4,
      basis: 'ema',
      source: 'high',
      standardDeviation: 1.5,
      offset: 1,
    });

    expect(result.params).toEqual({
      length: 4,
      basis: 'ema',
      source: 'high',
      standardDeviation: 1.5,
      offset: 1,
    });

    const first = result.middle.at(0);

    expect(first?.t).toBe(smallCandles[4].t);
    expect(first?.v).toBeGreaterThan(0);
    expect(result.upper.at(0)?.v).toBeGreaterThan(result.middle.at(0)?.v ?? 0);
    expect(result.lower.at(0)?.v).toBeLessThan(result.middle.at(0)?.v ?? 0);
  });

  it('returns empty series when no candles are provided', () => {
    const result = computeBollingerBands([]);

    expect(result.upper).toHaveLength(0);
    expect(result.middle).toHaveLength(0);
    expect(result.lower).toHaveLength(0);
  });

  it('validates parameters', () => {
    expect(() => computeBollingerBands(smallCandles, { length: 0 })).toThrow(/length must be a positive integer/);
    expect(() => computeBollingerBands(smallCandles, { basis: 'wma' as 'sma' })).toThrow(/basis must be either "sma" or "ema"/);
    expect(() => computeBollingerBands(smallCandles, { standardDeviation: -1 })).toThrow(/standardDeviation must be a non-negative finite number/);
    expect(() => computeBollingerBands(smallCandles, { offset: 1.2 })).toThrow(/offset must be an integer/);
  });
});

const buildCandles = (closes: number[]): Candle[] =>
  closes.map((close, index) => ({
    t: index,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
  }));

describe('Bollinger events', () => {
  it('reports metadata and detects band breaks', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['bollinger.break.aboveUpper', 'bollinger.break.belowLower']),
    );

    const candles = buildCandles([100, 100, 100, 140, 150, 120, 80, 70, 60]);
    const events = detectEvents(candles, { length: 3, standardDeviation: 1 });

    expect(events.some((event) => event.id === 'bollinger.break.aboveUpper')).toBe(true);
    expect(events.some((event) => event.id === 'bollinger.break.belowLower')).toBe(true);
  });
});

describe('Bollinger squeeze, release and re-entry (DWLF-337)', () => {
  // 160 volatile bars, 40 calm ones, then volatile again: one squeeze in the
  // calm stretch and one release once the swings come back.
  const wave = (i: number, amplitude: number) => 100 + amplitude * Math.sin(i / 2.3) + (i % 3) * amplitude * 0.2;
  const closes = [
    ...Array.from({ length: 160 }, (_, i) => wave(i, 8)),
    ...Array.from({ length: 40 }, (_, i) => wave(160 + i, 0.3)),
    ...Array.from({ length: 60 }, (_, i) => 100 + (i + 1) * 1.5 + 8 * Math.sin(i / 2.3)),
  ];
  const candles: Candle[] = closes.map((c, i) => ({ t: i * 86_400_000, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }));
  const events = detectEvents(candles);
  const ofId = (id: string) => events.filter((event) => event.id === id);

  it('advertises the new events', () => {
    expect(getEventDefinitions().map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['bollinger.squeeze', 'bollinger.squeeze.released', 'bollinger.reentry.fromAbove', 'bollinger.reentry.fromBelow']),
    );
  });

  it('squeezes in the calm stretch, once, and releases after it, rising', () => {
    const inCalm = ofId('bollinger.squeeze').filter((e) => (e.index as number) >= 160 && (e.index as number) < 200);
    expect(inCalm).toHaveLength(1);
    const [squeeze] = inCalm;
    const release = ofId('bollinger.squeeze.released').find((e) => (e.index as number) > (squeeze.index as number));
    if (!release) {
      throw new Error('no release after the calm-stretch squeeze');
    }
    expect(release.index).toBeGreaterThanOrEqual(200);
    expect(squeeze.payload as BollingerSqueezePayload).toMatchObject({ threshold: 20 });
    expect((squeeze.payload as BollingerSqueezePayload).percentile).toBeLessThanOrEqual(20);
    expect(release.payload as BollingerSqueezePayload).toMatchObject({ threshold: 50, direction: 'up' });
    expect((release.payload as BollingerSqueezePayload).percentile).toBeGreaterThanOrEqual(50);
  });

  it('never opens a history on a squeeze event', () => {
    // Swings that only ever shrink: band width is at the bottom of its range
    // from the first ranked bar on, so that bar sets the state and nothing fires.
    const shrinking: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const c = 100 + (40 - i / 3) * Math.sin(i / 1.7);
      return { t: i * 86_400_000, o: c, h: c + 0.1, l: c - 0.1, c, v: 1 };
    });
    expect(detectEvents(shrinking, { percentileWindow: 20 }).filter((e) => e.id.startsWith('bollinger.squeeze'))).toEqual([]);
  });

  it('fires alternately: no second squeeze before a release', () => {
    const sequence = events.filter((e) => e.id.startsWith('bollinger.squeeze')).map((e) => e.id);
    sequence.forEach((id, k) => {
      if (k > 0) {
        expect(id).not.toBe(sequence[k - 1]);
      }
    });
  });

  it('fires a re-entry on the first close back inside after a close outside', () => {
    const { upper, lower } = computeBollingerBands(candles);
    const bandAt = (series: typeof upper, t: number) => series.find((point) => point.t === t)?.v;
    for (const event of [...ofId('bollinger.reentry.fromAbove'), ...ofId('bollinger.reentry.fromBelow')]) {
      const i = event.index as number;
      const fromAbove = event.id === 'bollinger.reentry.fromAbove';
      const band = fromAbove ? upper : lower;
      const [prevBand, nowBand] = [bandAt(band, candles[i - 1].t) as number, bandAt(band, candles[i].t) as number];
      expect(fromAbove ? candles[i - 1].c > prevBand : candles[i - 1].c < prevBand).toBe(true);
      expect(fromAbove ? candles[i].c <= nowBand : candles[i].c >= nowBand).toBe(true);
      expect(event.payload as BollingerReentryPayload).toEqual({ price: candles[i].c, bandValue: nowBand, band: fromAbove ? 'upper' : 'lower', source: 'close' });
    }
    expect(ofId('bollinger.reentry.fromAbove').length + ofId('bollinger.reentry.fromBelow').length).toBeGreaterThan(0);
  });

  it('keeps events in bar order', () => {
    const indices = events.map((event) => event.index as number);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('refuses squeeze levels that are not 0 < squeeze < release < 100', () => {
    for (const bad of [{ squeezePercentile: 0 }, { releasePercentile: 100 }, { squeezePercentile: 60, releasePercentile: 40 }, { percentileWindow: 0 }]) {
      expect(() => detectEvents(candles, bad)).toThrow();
    }
  });

  it('leaves the bands and their resolved params untouched by the event options', () => {
    expect(computeBollingerBands(candles, { squeezePercentile: 10 } as never)).toEqual(computeBollingerBands(candles));
  });
});
