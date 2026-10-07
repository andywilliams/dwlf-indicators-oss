import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { computeSwings } from '../swing/swing';
import { detectEvents } from './trendline.v1';

// A deterministic random walk with enough drift and chop to form many lines
// and breaks.
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
    close = Math.max(1, open + (rand() - 0.5) * 4 + Math.sin(i / 25) * 0.6);
    const high = Math.max(open, close) + rand() * 2;
    const low = Math.min(open, close) - rand() * 2;
    candles.push({ t: 1_700_000_000_000 + i * 86_400_000, o: open, h: high, l: low, c: close, v: 1000 });
  }
  return candles;
};

const key = (e: { id: string; index?: number; t?: number; payload?: unknown }) =>
  JSON.stringify([e.id, e.index, e.t, e.payload]);

// DWLF-330: a break fires on the bar it happens, against the lines knowable
// on that bar. Run on the series cut at any bar, the events are exactly the
// full run's events up to that bar.
describe('trendline v1 events are walk-forward stable', () => {
  for (const [seed, swingLookback] of [[11, 5], [3, 3], [29, 2]]) {
    it(`a truncated run equals the full run's prefix (seed ${seed}, swingLookback ${swingLookback})`, () => {
      const candles = walk(400, seed);
      const full = detectEvents(candles, { swingLookback });
      expect(full.length).toBeGreaterThan(10);
      for (let k = 2; k < candles.length; k += 1) {
        const truncated = detectEvents(candles.slice(0, k + 1), { swingLookback }).map(key).sort();
        const prefix = full.filter((e) => (e.index ?? -1) <= k).map(key).sort();
        expect(truncated, `cut at bar ${k}`).toEqual(prefix);
      }
    });
  }

  it('a break is measured against a line whose pivots were all knowable on that bar', () => {
    const swingLookback = 5;
    const events = detectEvents(walk(400), { swingLookback });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const payload = e.payload as { anchorIndex: number; endIndex: number };
      expect(payload.anchorIndex + swingLookback).toBeLessThanOrEqual(e.index as number);
      expect(payload.endIndex).toBe(e.index);
    }
  });

  type Payload = { lineType: 'support' | 'resistance'; startIndex: number; anchorIndex: number; variant: string };

  it('a line stops firing once a pivot that terminates it is knowable', () => {
    const swingLookback = 3;
    const candles = walk(400, 3);
    const { lows, highs } = computeSwings(candles, { lookback: swingLookback });
    const events = detectEvents(candles, { swingLookback });
    expect(events.length).toBeGreaterThan(10);
    for (const e of events) {
      const payload = e.payload as Payload;
      const isSupport = payload.lineType === 'support';
      const pivots = (isSupport ? lows : highs)
        .filter((p) => p.index >= payload.anchorIndex && p.index + swingLookback <= (e.index as number));
      // Support ends at the first lower low after its anchor, resistance at the first higher high.
      let last = pivots[0].price;
      for (const pivot of pivots.slice(1)) {
        expect(isSupport ? pivot.price >= last : pivot.price <= last, `${e.id}@${e.index}`).toBe(true);
        last = pivot.price;
      }
    }
  });

  it('a line closes through at most once and is silent after', () => {
    for (const [seed, swingLookback] of [[11, 5], [3, 3], [29, 2]]) {
      const events = detectEvents(walk(400, seed), { swingLookback });
      const closedAt = new Map<string, number>();
      for (const e of events) {
        const payload = e.payload as Payload;
        const line = `${payload.lineType}:${payload.startIndex}:${payload.anchorIndex}`;
        const closed = closedAt.get(line);
        if (closed !== undefined) {
          expect(e.index, `${line} fired at ${e.index} after closing through at ${closed}`).toBe(closed);
        }
        if (payload.variant === 'close') {
          expect(closed, `${line} closed through twice`).toBeUndefined();
          closedAt.set(line, e.index as number);
        }
      }
      expect(closedAt.size).toBeGreaterThan(3);
    }
  });
});

