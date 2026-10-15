import { describe, expect, it } from 'vitest';

import type { Candle, LinePoint } from '../../types';
import { computeSwings } from '../swing/swing';
import { computeRsi } from '../rsi/rsi';
import {
  detectDivergences,
  eventDefinitionsFor,
  getEventDefinitions,
  resolveDivergenceParams,
  type DivergencePivot,
} from './divergence';

const DAY = 86_400_000;
const flat = (count: number): Candle[] =>
  Array.from({ length: count }, (_, i) => ({ t: i * DAY, o: 100, h: 101, l: 99, c: 100, v: 0 }));
const oscillatorOf = (candles: Candle[], values: Record<number, number>): LinePoint[] =>
  Object.entries(values).map(([i, v]) => ({ t: candles[Number(i)].t, v }));

describe('Divergence definitions', () => {
  it('names ids by prefix, and has no definitions of its own', () => {
    expect(eventDefinitionsFor('rsi', 'RSI').map((d) => d.id)).toEqual([
      'rsi.divergence.regular.bullish',
      'rsi.divergence.hidden.bullish',
      'rsi.divergence.regular.bearish',
      'rsi.divergence.hidden.bearish',
    ]);
    expect(eventDefinitionsFor('dss', 'DSS')[0].name).toBe('DSS Bullish Divergence');
    expect(getEventDefinitions()).toEqual([]);
    expect(() => eventDefinitionsFor('bad prefix', 'x')).toThrow();
  });

  it('validates params', () => {
    expect(() => resolveDivergenceParams({ idPrefix: 'rsi', minBars: 10, maxBars: 5 })).toThrow();
    expect(() => resolveDivergenceParams({ idPrefix: 'rsi', minOscillatorDelta: -1 })).toThrow();
    expect(() => resolveDivergenceParams({ idPrefix: '' })).toThrow();
  });
});

describe('detectDivergences', () => {
  const candles = flat(60);
  const low = (index: number, price: number, knowableIndex = index + 3): DivergencePivot => ({
    side: 'low',
    index,
    knowableIndex,
    price,
  });
  const high = (index: number, price: number, knowableIndex = index + 3): DivergencePivot => ({
    side: 'high',
    index,
    knowableIndex,
    price,
  });

  it('classifies all four types and stamps at the later pivot\'s knowable bar', () => {
    const osc = oscillatorOf(candles, { 10: 20, 20: 30, 30: 25, 40: 70, 50: 60 });
    const events = detectDivergences(
      candles,
      osc,
      [low(10, 90), low(20, 85), low(30, 88), high(40, 110), high(50, 112)],
      { idPrefix: 'rsi', source: { oscillator: 'rsi', length: 14 } },
    );
    expect(events.map((e) => [e.id, e.index])).toEqual([
      ['rsi.divergence.regular.bullish', 23], // LL 90->85, osc HL 20->30
      ['rsi.divergence.hidden.bullish', 33], // HL 85->88, osc LL 30->25
      ['rsi.divergence.regular.bearish', 53], // HH 110->112, osc LH 70->60
    ]);
    expect(events[0].payload).toMatchObject({
      kind: 'regular',
      direction: 'bullish',
      side: 'low',
      pivotIndex: 20,
      pivotPrice: 85,
      oscillatorValue: 30,
      previousPivotIndex: 10,
      previousOscillatorValue: 20,
      barsBetween: 10,
      source: { oscillator: 'rsi', length: 14 },
    });
    const hidden = detectDivergences(candles, oscillatorOf(candles, { 10: 70, 20: 75 }), [high(10, 110), high(20, 105)], {
      idPrefix: 'dss',
    });
    expect(hidden.map((e) => e.id)).toEqual(['dss.divergence.hidden.bearish']);
  });

  it('defaults the price to the candle low or high', () => {
    const shaped = flat(30);
    shaped[10] = { ...shaped[10], l: 90 };
    shaped[20] = { ...shaped[20], l: 80 };
    const events = detectDivergences(
      shaped,
      oscillatorOf(shaped, { 10: 20, 20: 30 }),
      [{ side: 'low', index: 10, knowableIndex: 12 }, { side: 'low', index: 20, knowableIndex: 22 }],
      { idPrefix: 'rsi' },
    );
    expect(events.map((e) => e.payload?.pivotPrice)).toEqual([80]);
  });

  it('respects spacing, delta, equal prices and missing values', () => {
    const osc = oscillatorOf(candles, { 10: 20, 12: 30, 30: 20.5 });
    const p = [low(10, 90), low(12, 85)];
    expect(detectDivergences(candles, osc, p, { idPrefix: 'rsi' })).toHaveLength(0); // 2 bars < minBars 5
    expect(detectDivergences(candles, osc, p, { idPrefix: 'rsi', minBars: 2 })).toHaveLength(1);
    expect(detectDivergences(candles, osc, [low(10, 90), low(30, 85)], { idPrefix: 'rsi', minOscillatorDelta: 1 })).toHaveLength(0);
    expect(detectDivergences(candles, osc, [low(10, 90), low(30, 90)], { idPrefix: 'rsi' })).toHaveLength(0);
    expect(detectDivergences(candles, osc, [low(10, 90), low(40, 85)], { idPrefix: 'rsi' })).toHaveLength(0); // no value at 40
    expect(detectDivergences(candles, osc, [low(10, 90), low(30, 85)], { idPrefix: 'rsi', maxBars: 19 })).toHaveLength(0);
  });

  it('skips a pair whose knowable bar is past the series', () => {
    const osc = oscillatorOf(candles, { 10: 20, 55: 30 });
    expect(detectDivergences(candles, osc, [low(10, 90), low(55, 85, 70)], { idPrefix: 'rsi' })).toHaveLength(0);
  });

  it('a pivot confirmed late never changes an earlier comparison', () => {
    // Pivot at 20 is only knowable at 45, after pivot 30 is knowable (33).
    const osc = oscillatorOf(candles, { 10: 20, 20: 40, 30: 30 });
    const events = detectDivergences(candles, osc, [low(10, 90), low(20, 80, 45), low(30, 95)], { idPrefix: 'rsi' });
    // At 33, 30 compares with 10 (higher low, oscillator higher low: nothing). At 45, 20 compares with 10 (LL, osc HL).
    expect(events.map((e) => [e.id, e.index, e.payload?.previousPivotIndex])).toEqual([
      ['rsi.divergence.regular.bullish', 45, 10],
    ]);
  });
});

// A deterministic random walk with enough chop to form many swings.
const walk = (count: number, seed = 11): Candle[] => {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    close = Math.max(1, open + (rand() - 0.5) * 4);
    candles.push({
      t: 1_700_000_000_000 + i * DAY,
      o: open,
      h: Math.max(open, close) + rand() * 2,
      l: Math.min(open, close) - rand() * 2,
      c: close,
      v: 1000,
    });
  }
  return candles;
};

const key = (e: { id: string; index?: number; payload?: unknown }) => JSON.stringify([e.id, e.index, e.payload]);

// DWLF-330: run on the series cut at any bar (oscillator recomputed, pivots
// filtered to those knowable by then), the events are exactly the full run's
// events up to that bar.
describe('divergence events are walk-forward stable', () => {
  const candles = walk(400);
  const lookback = 3;
  const swings = computeSwings(candles, { lookback });
  const pivots: DivergencePivot[] = swings.points.map((p) => ({
    side: p.type,
    index: p.index,
    knowableIndex: p.index + lookback,
  }));
  // Shuffle confirmation order a little, so some pivots confirm out of order.
  const lagged = pivots.map((p, i) => (i % 5 === 0 ? { ...p, knowableIndex: p.knowableIndex + 12 } : p));

  for (const [name, set] of [['swing pivots', pivots], ['out-of-order confirmations', lagged]] as const) {
    it(`a truncated run equals the full run's prefix (${name})`, () => {
      const run = (cs: Candle[], ps: DivergencePivot[]) =>
        detectDivergences(cs, computeRsi(cs).rsi, ps, { idPrefix: 'rsi', source: { pivots: 'swing' } });
      const full = run(candles, set);
      expect(full.length).toBeGreaterThan(5);
      for (let k = 20; k < candles.length; k += 1) {
        const truncated = run(candles.slice(0, k + 1), set.filter((p) => p.knowableIndex <= k)).map(key).sort();
        const prefix = full.filter((e) => (e.index ?? -1) <= k).map(key).sort();
        expect(truncated).toEqual(prefix);
      }
    });
  }
});
