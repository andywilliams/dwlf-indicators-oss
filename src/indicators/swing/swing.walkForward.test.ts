import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { detectEvents } from './swing';

// A deterministic random walk with enough chop to form many swings, breaks
// and sweeps.
const walk = (count: number, seed = 7): Candle[] => {
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
    const high = Math.max(open, close) + rand() * 2;
    const low = Math.min(open, close) - rand() * 2;
    candles.push({ t: 1_700_000_000_000 + i * 86_400_000, o: open, h: high, l: low, c: close, v: 1000 });
  }
  return candles;
};

const key = (e: { id: string; index?: number; t?: number; payload?: unknown }) =>
  JSON.stringify([e.id, e.index, e.t, e.payload]);

// DWLF-330: an event's bar is the bar it became knowable. Run on the series
// cut at any bar, the events are exactly the full run's events up to that bar.
describe('swing events are walk-forward stable', () => {
  const candles = walk(400);

  for (const lookback of [3, 5]) {
    it(`a truncated run equals the full run's prefix (lookback ${lookback})`, () => {
      const full = detectEvents(candles, { lookback });
      expect(full.length).toBeGreaterThan(50);
      for (let k = 20; k < candles.length; k += 7) {
        const truncated = detectEvents(candles.slice(0, k + 1), { lookback }).map(key).sort();
        const prefix = full.filter((e) => (e.index ?? -1) <= k).map(key).sort();
        expect(truncated, `cut at bar ${k}`).toEqual(prefix);
      }
    });
  }

  it('formed and comparison events sit lookback bars after their pivot', () => {
    const lookback = 5;
    const events = detectEvents(candles, { lookback });
    const pivotal = events.filter((e) => /formed|higher|lower/.test(e.id));
    expect(pivotal.length).toBeGreaterThan(0);
    for (const e of pivotal) {
      const payload = e.payload as { pivotIndex: number; pivotTime: number };
      expect(e.index).toBe(payload.pivotIndex + lookback);
      expect(e.t).toBe(candles[e.index as number].t);
      expect(payload.pivotTime).toBe(candles[payload.pivotIndex].t);
    }
  });
});
