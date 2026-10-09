import { describe, expect, it } from 'vitest';

import { flatCandles } from '../../../test/fixtures/candles.edgecases';
import { smallCandles } from '../../../test/fixtures/candles.small';
import { computeDSS, detectEvents, getEventDefinitions } from './dss';
import { initDSS, updateDSS } from './dss.state';

describe('DSS.computeDSS', () => {
  it('computes double smoothed stochastic values with defaults', () => {
    const result = computeDSS(smallCandles);

    expect(result.params).toMatchObject({ length: 13, smooth1: 8, signal: 3 });
    expect(result.dss.length).toBeGreaterThan(0);
    expect(result.signal.length).toBeGreaterThan(0);

    const lastDss = result.dss.at(-1);
    const lastSignal = result.signal.at(-1);

    expect(lastDss?.v).toBeGreaterThanOrEqual(0);
    expect(lastDss?.v).toBeLessThanOrEqual(100);
    expect(lastSignal?.v).toBeGreaterThanOrEqual(0);
    expect(lastSignal?.v).toBeLessThanOrEqual(100);
    expect(lastSignal?.t).toBe(lastDss?.t);
  });

  it('respects custom parameters', () => {
    const defaults = computeDSS(smallCandles);
    const custom = computeDSS(smallCandles, {
      length: 10,
      smooth1: 5,
      signal: 2,
    });

    expect(custom.params).toMatchObject({ length: 10, smooth1: 5, signal: 2 });
    const differ =
      custom.dss.length !== defaults.dss.length ||
      custom.dss.some((point, index) => {
        const other = defaults.dss[index];
        if (!other) return true;
        return Math.abs(point.v - other.v) > 1e-6;
      });

    expect(differ).toBe(true);
  });

  it('returns empty series when no candles are provided', () => {
    const result = computeDSS([]);

    expect(result.dss).toHaveLength(0);
    expect(result.signal).toHaveLength(0);
  });
});

describe('DSS events', () => {
  it('exposes metadata and emits crossover and level events', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'dss.cross.bullish',
        'dss.cross.bearish',
        'dss.level.overbought',
        'dss.level.oversold',
      ]),
    );

    const events = detectEvents(smallCandles, { length: 5, smooth1: 3, signal: 2 });
    expect(events.length).toBeGreaterThan(0);

    const crossover = events.find((event) => event.id === 'dss.cross.bullish');
    expect(crossover?.payload?.dss).toBeGreaterThanOrEqual(0);
    expect((crossover?.payload as { signal?: number })?.signal).toBeGreaterThanOrEqual(0);

    const overbought = events.find((event) => event.id === 'dss.level.overbought');
    const oversold = events.find((event) => event.id === 'dss.level.oversold');

    expect(overbought?.payload).toMatchObject({ threshold: 80, state: 'overbought' });
    expect(oversold?.payload).toMatchObject({ threshold: 20, state: 'oversold' });
  });
});

describe('DSS zone exits and configurable levels (DWLF-337)', () => {
  const params = { length: 5, smooth1: 3, signal: 2 };
  const points = computeDSS(smallCandles, params).dss;
  const series = points.map((point) => point.v);
  const byTime = new Map(points.map((point) => [point.t, point.v]));
  const dssAt = (t: number) => byTime.get(t) as number;

  it('advertises the exit events', () => {
    expect(getEventDefinitions().map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['dss.exit.overbought', 'dss.exit.oversold']),
    );
  });

  it('fires an exit on each bar the line leaves a zone, and never with an entry on the same bar', () => {
    const events = detectEvents(smallCandles, params);
    const exits = events.filter((event) => event.id.startsWith('dss.exit.'));
    expect(exits.length).toBeGreaterThan(0);

    for (const exit of exits) {
      const i = exit.index as number;
      const prev = dssAt(smallCandles[i - 1].t);
      const now = dssAt(smallCandles[i].t);
      if (exit.id === 'dss.exit.overbought') {
        expect(prev).toBeGreaterThan(80);
        expect(now).toBeLessThanOrEqual(80);
      } else {
        expect(prev).toBeLessThan(20);
        expect(now).toBeGreaterThanOrEqual(20);
      }
      expect(exit.payload).toMatchObject({ threshold: exit.id === 'dss.exit.overbought' ? 80 : 20 });
      expect(events.some((e) => e.index === i && e.id === exit.id.replace('exit', 'level'))).toBe(false);
    }
  });

  it('counts every zone crossing in the series exactly once', () => {
    let crossings = 0;
    for (let i = 1; i < series.length; i += 1) {
      const [prev, now] = [series[i - 1], series[i]];
      if ((prev <= 80 && now > 80) || (prev > 80 && now <= 80) || (prev >= 20 && now < 20) || (prev < 20 && now >= 20)) {
        crossings += 1;
      }
    }
    const zoneEvents = detectEvents(smallCandles, params).filter((e) => e.id.startsWith('dss.level.') || e.id.startsWith('dss.exit.'));
    expect(zoneEvents).toHaveLength(crossings);
  });

  it('uses configured levels for both entries and exits', () => {
    const events = detectEvents(smallCandles, { ...params, overbought: 70, oversold: 30 });
    const thresholds = new Set(
      events.filter((e) => e.id.startsWith('dss.level.') || e.id.startsWith('dss.exit.')).map((e) => (e.payload as { threshold: number }).threshold),
    );
    expect([...thresholds].sort()).toEqual([30, 70]);
  });

  it('leaves the DSS values and their resolved params untouched', () => {
    expect(computeDSS(smallCandles, { ...params, overbought: 70, oversold: 30 } as never)).toEqual(computeDSS(smallCandles, params));
    const crosses = (p: object) => detectEvents(smallCandles, p).filter((e) => e.id.startsWith('dss.cross.'));
    expect(crosses({ ...params, overbought: 70, oversold: 30 })).toEqual(crosses(params));
  });

  it('refuses levels that are not 0 < oversold < overbought < 100', () => {
    for (const bad of [{ overbought: 100 }, { oversold: 0 }, { overbought: 40, oversold: 60 }, { overbought: Number.NaN }]) {
      expect(() => detectEvents(smallCandles, { ...params, ...bad })).toThrow(RangeError);
    }
  });
});

describe('DSS incremental state', () => {
  it('matches batch computation when updated sequentially', () => {
    const batch = computeDSS(smallCandles);

    const state = initDSS();
    let current = state;
    let lastDss;
    let lastSignal;

    for (const candle of smallCandles) {
      const update = updateDSS(current, [candle]);
      current = update.state;
      if (update.dssPoint) {
        lastDss = update.dssPoint;
      }
      if (update.signalPoint) {
        lastSignal = update.signalPoint;
      }
    }

    expect(lastDss).toEqual(batch.dss.at(-1));
    expect(lastSignal).toEqual(batch.signal.at(-1));
  });

  it('guards flat periods by pinning to 50', () => {
    const result = computeDSS(flatCandles, { length: 3, smooth1: 2, signal: 2 });
    const first = result.dss.at(0);

    expect(first?.v).toBe(50);
  });
});
