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
