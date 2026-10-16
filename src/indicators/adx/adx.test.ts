import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { dmi } from '../../math/adx';
import { computeADX, detectEvents, getEventDefinitions, resolveAdxParams } from './adx';

// An independent, textbook Wilder DMI/ADX (written separately from math/adx.ts).
const reference = (candles: Candle[], n = 14) => {
  const out = candles.map(() => ({ p: NaN, m: NaN, a: NaN }));
  let sTr = 0, sP = 0, sM = 0, k = 0, a = NaN;
  const seed: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const [c, q] = [candles[i], candles[i - 1]];
    const up = c.h - q.h;
    const dn = q.l - c.l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - q.c), Math.abs(c.l - q.c));
    k += 1;
    if (k <= n) { sTr += tr; sP += pdm; sM += mdm; if (k < n) { continue; } }
    else { sTr = sTr - sTr / n + tr; sP = sP - sP / n + pdm; sM = sM - sM / n + mdm; }
    const p = (100 * sP) / sTr;
    const m = (100 * sM) / sTr;
    const dx = (100 * Math.abs(p - m)) / (p + m);
    if (Number.isNaN(a)) { seed.push(dx); if (seed.length === n) { a = seed.reduce((x, y) => x + y) / n; } }
    else { a = (a * (n - 1) + dx) / n; }
    out[i] = { p, m, a };
  }
  return out;
};

const DAY = 86_400_000;
const wave = (length: number, f: (t: number) => number): Candle[] => Array.from({ length }, (_, t) => {
  const c = f(t);
  return { t: t * DAY, o: c, h: c + 1 + 0.5 * Math.abs(Math.sin(t)), l: c - 1 - 0.5 * Math.abs(Math.cos(t)), c, v: 1 };
});

// Flat-ish chop, then a steady climb, then chop again, then a steady fall.
const regime = wave(300, (t) => {
  if (t < 60) {return 100 + 2 * Math.sin(t / 2);}
  if (t < 130) {return 100 + (t - 60) * 1.5;}
  if (t < 200) {return 205 + 2 * Math.sin(t / 2);}
  return 205 - (t - 200) * 1.5;
});

describe('dmi', () => {
  it('matches a textbook Wilder DMI/ADX', () => {
    const ours = dmi(regime, 14);
    const ref = reference(regime, 14);
    for (let i = 0; i < regime.length; i += 1) {
      if (Number.isNaN(ref[i].p)) {
        expect(ours.plusDI[i]).toBeUndefined();
        continue;
      }
      expect(ours.plusDI[i]).toBeCloseTo(ref[i].p, 10);
      expect(ours.minusDI[i]).toBeCloseTo(ref[i].m, 10);
      if (Number.isNaN(ref[i].a)) {expect(ours.adx[i]).toBeUndefined();}
      else {expect(ours.adx[i]).toBeCloseTo(ref[i].a, 10);}
    }
    // DIs from bar `period`, ADX from bar 2 * period - 1.
    expect(ours.plusDI.findIndex((v) => v !== undefined)).toBe(14);
    expect(ours.adx.findIndex((v) => v !== undefined)).toBe(27);
  });

  it('restarts after a candle with no high, low or close', () => {
    const gapped = regime.map((c, i) => (i === 100 ? { ...c, h: Number.NaN } : c));
    const ours = dmi(gapped, 14);
    expect(ours.adx[100]).toBeUndefined();
    expect(ours.adx[101 + 26]).toBeUndefined();
    expect(ours.adx[101 + 27]).toBeDefined();
  });
});

describe('ADX', () => {
  it('advertises its five events under one prefix', () => {
    expect(getEventDefinitions().map((d) => d.id)).toEqual([
      'adx.trend.started.bullish', 'adx.trend.started.bearish', 'adx.trend.faded',
      'adx.di.cross.bullish', 'adx.di.cross.bearish',
    ]);
  });

  it('computes the three lines aligned to the candles', () => {
    const result = computeADX(regime);
    expect(result.params).toEqual({ length: 14, trendLevel: 25, fadeLevel: 20, crossMinAdx: 20 });
    expect(result.adx[0].t).toBe(regime[27].t);
    expect(result.plusDI[0].t).toBe(regime[14].t);
  });

  it('starts a trend each way on the climb and the fall, and fades it in the chop between', () => {
    const trend = detectEvents(regime).filter((e) => e.id.startsWith('adx.trend.'));
    expect(trend.map((e) => e.id)).toEqual([
      'adx.trend.started.bullish', 'adx.trend.faded', 'adx.trend.started.bearish',
    ]);
    const [start, fade, down] = trend;
    expect(start.index).toBeGreaterThan(60);
    expect(start.index).toBeLessThan(130);
    expect(fade.index).toBeGreaterThan(130);
    expect(fade.index).toBeLessThan(200);
    expect(down.index).toBeGreaterThan(200);
    expect(start.payload).toMatchObject({ direction: 'bullish', threshold: 25, length: 14 });
    expect(start.payload?.adx).toBeGreaterThanOrEqual(25);
    expect(start.payload?.previousAdx).toBeLessThan(25);
    expect(fade.payload).toMatchObject({ direction: 'bullish', threshold: 20 });
    expect(fade.payload?.adx).toBeLessThan(20);
  });

  it('uses hysteresis: no fade until ADX is below the fade level, however long it sits between', () => {
    const { adx } = dmi(regime, 14);
    for (const event of detectEvents(regime).filter((e) => e.id === 'adx.trend.faded')) {
      const i = event.index as number;
      const startIndex = detectEvents(regime).filter((e) => e.id.startsWith('adx.trend.started') && (e.index as number) < i).at(-1)?.index as number;
      for (let j = startIndex + 1; j < i; j += 1) {expect(adx[j]).toBeGreaterThanOrEqual(20);}
    }
  });

  it('fires DI crosses only while ADX is at or above the cross level', () => {
    const { adx, plusDI, minusDI } = dmi(regime, 14);
    const crosses = detectEvents(regime).filter((e) => e.id.startsWith('adx.di.cross.'));
    for (const event of crosses) {
      const i = event.index as number;
      expect(adx[i]).toBeGreaterThanOrEqual(20);
      const bullish = event.id === 'adx.di.cross.bullish';
      expect((plusDI[i] as number) > (minusDI[i] as number)).toBe(bullish);
      expect(event.payload?.direction).toBe(bullish ? 'bullish' : 'bearish');
    }
    const ungated = detectEvents(regime, { crossMinAdx: 0 }).filter((e) => e.id.startsWith('adx.di.cross.'));
    expect(ungated.length).toBeGreaterThan(crosses.length);
  });

  it('uses no later bar: a run on every prefix reproduces the full-run events up to it', () => {
    const full = detectEvents(regime);
    for (let k = 0; k < regime.length; k += 1) {
      expect(detectEvents(regime.slice(0, k + 1))).toEqual(full.filter((e) => (e.index as number) <= k));
    }
  });

  it('refuses bad parameters', () => {
    expect(() => resolveAdxParams({ length: 0 })).toThrow();
    expect(() => resolveAdxParams({ trendLevel: 20, fadeLevel: 25 })).toThrow(TypeError);
    expect(() => resolveAdxParams({ crossMinAdx: 120 })).toThrow(TypeError);
  });
});
