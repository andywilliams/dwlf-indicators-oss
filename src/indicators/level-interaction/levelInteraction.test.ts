import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import {
  LEVEL_EVENT_KINDS,
  eventDefinitionsFor,
  getEventDefinitions,
  keepNearestApproaches,
  resolveLevelInteractionParams,
  trackLevelInteractions,
  type LevelInput,
  type LevelInteractionParams,
} from './levelInteraction';

const DAY = 86_400_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: i * DAY, o, h, l, c, v: 0 });

// 20 calm bars of range 2 around `mid` (ATR settles at 2), then the scenario.
const warm = (mid: number, n = 20): Candle[] =>
  Array.from({ length: n }, (_, i) => bar(i, mid, mid + 1, mid - 1, mid));
const series = (mid: number, tail: Array<[number, number, number, number]>): Candle[] => {
  const head = warm(mid);
  return [...head, ...tail.map(([o, h, l, c], k) => bar(head.length + k, o, h, l, c))];
};

// Support at 100. ATR = 2, so with defaults: band 99.7-100.3, break buffer 0.5
// (a close below 99.2), approach within 1.0 of the band (close ≤ 101.3).
const support = (over: Partial<LevelInput> = {}): LevelInput => ({
  id: 's100',
  geometry: { kind: 'horizontal', price: 100 },
  role: 'support',
  knowableIndex: 19,
  ...over,
});
const P: LevelInteractionParams & { idPrefix: string } = { idPrefix: 'test.level', atrLength: 14 };
const kinds = (candles: Candle[], levels: LevelInput[] = [support()], params = P) =>
  trackLevelInteractions(candles, levels, params).events.map((e) => [e.payload!.kind, e.index]);

describe('trackLevelInteractions: one scenario per event', () => {
  it('formed at the knowable bar, then approached, tested and rejected (the level held)', () => {
    const candles = series(110, [
      [110, 111, 109, 110],
      [104, 104, 100.8, 101], // close 101: within 1.0 of the band's top (100.3) -> approached
      [101, 101.5, 99.9, 101.2], // wick into the band, close above it -> tested + rejected
    ]);
    expect(kinds(candles)).toEqual([
      ['formed', 19],
      ['approached', 21],
      ['tested', 22],
      ['rejected', 22],
    ]);
  });

  it('broken on a close beyond the buffer, then retested and flipped (support became resistance)', () => {
    const candles = series(103, [
      [101, 101, 98, 98.5], // close 98.5 < 99.2 -> broken (bearish)
      [98.5, 99, 97, 97.5],
      [97.5, 99.9, 97.4, 98], // high reaches the band from below -> retested, close below it -> flipped
    ]);
    const { events, states } = trackLevelInteractions(candles, [support()], P);
    expect(events.map((e) => [e.payload!.kind, e.index, e.payload!.direction])).toEqual([
      ['formed', 19, 'neutral'],
      ['broken', 20, 'bearish'],
      ['retested', 22, 'neutral'],
      ['flipped', 22, 'bearish'],
    ]);
    expect(states[0]).toMatchObject({ role: 'resistance', confirmed: true, originalRole: 'support' });
  });

  it('reclaimed when price closes back through within reclaimBars (a failed break)', () => {
    const candles = series(103, [
      [101, 101, 98, 98.5], // broken
      [98.5, 101.5, 98.4, 101], // close 101 > band top 100.3 + 0.5 -> reclaimed (bullish)
    ]);
    const { events, states } = trackLevelInteractions(candles, [support()], P);
    expect(events.slice(1).map((e) => [e.payload!.kind, e.index, e.payload!.direction])).toEqual([
      ['broken', 20, 'bearish'],
      ['reclaimed', 21, 'bullish'],
    ]);
    expect(states[0]).toMatchObject({ role: 'support', confirmed: true });
  });

  it('a quick retest-and-flip does not close the reclaim window', () => {
    const candles = series(103, [
      [101, 101, 98.8, 99.0], // broken
      [99, 99.8, 98.9, 99.2], // retested + flipped on the very next bar
      [99.2, 101.5, 99.1, 101.2], // back through within reclaimBars: the break failed
    ]);
    expect(kinds(candles).slice(1)).toEqual([
      ['broken', 20],
      ['retested', 21],
      ['flipped', 21],
      ['reclaimed', 22],
    ]);
  });

  it('a late return through after reclaimBars is a fresh break of the provisional role, not a reclaim', () => {
    const below = Array.from({ length: 6 }, () => [97, 97.5, 96.5, 97] as [number, number, number, number]);
    const candles = series(103, [[101, 101, 98, 98.5], ...below, [97, 101.5, 97, 101]]);
    const tail = kinds(candles, [support()], { ...P, reclaimBars: 5 }).slice(-1);
    expect(tail).toEqual([['broken', 27]]);
  });

  it('expired at the bar it becomes knowable: the expiryBars-th quiet bar, or endIndex', () => {
    const away = Array.from({ length: 6 }, () => [110, 111, 109, 110] as [number, number, number, number]);
    const candles = series(110, away);
    expect(kinds(candles, [support()], { ...P, expiryBars: 3 })).toEqual([
      ['formed', 19],
      ['expired', 22],
    ]);
    expect(kinds(candles, [support({ endIndex: 21 })])).toEqual([
      ['formed', 19],
      ['expired', 21],
    ]);
    // endIndex on the last candle still expires the level, in events and state.
    const last = trackLevelInteractions(candles, [support({ endIndex: candles.length - 1 })], P);
    expect(last.events.at(-1)?.payload?.kind).toBe('expired');
    expect(last.states[0].expired).toBe(true);
  });
});

describe('episode de-dupe', () => {
  it('approached fires once per episode, and again only after moving approachResetAtr away', () => {
    const candles = series(110, [
      [105, 105, 101, 101], // approached
      [101, 101.5, 100.6, 101.1], // still near: no repeat
      [101, 104, 101, 104], // 3.7 above the band: > 1.0 ATR*2 = 2 -> episode closes
      [104, 104, 101, 101.2], // approached again
    ]);
    expect(kinds(candles).filter(([k]) => k === 'approached')).toEqual([
      ['approached', 20],
      ['approached', 23],
    ]);
  });

  it('hovering at a level after a hold is one episode; a new test needs touchResetAtr away first', () => {
    const hover = Array.from({ length: 4 }, () => [101, 101.5, 100.1, 101] as [number, number, number, number]);
    const candles = series(110, [
      [104, 104, 100.1, 101], // tested + rejected
      ...hover, // wick back into the band and close above, bar after bar: nothing
      [101, 103, 101, 103], // close 2.7 above the band: re-armed
      [103, 103, 100.1, 101], // a new episode: tested + rejected
    ]);
    expect(kinds(candles).slice(1)).toEqual([
      ['tested', 20],
      ['rejected', 20],
      ['tested', 26],
      ['rejected', 26],
    ]);
  });

  it('a hold bar that closes beyond touchResetAtr re-arms at once', () => {
    const candles = series(110, [
      [104, 106, 100.1, 106], // tested + rejected, closing 2.85 ATR above the band
      [105, 105, 100.1, 102], // straight back to the level: a new episode
    ]);
    expect(kinds(candles).slice(1)).toEqual([
      ['tested', 20],
      ['rejected', 20],
      ['tested', 21],
      ['rejected', 21],
    ]);
  });

  it('no approached on the bar after a break: price has just come through the level', () => {
    const candles = series(103, [
      [101, 101, 98.8, 99.0], // broken: close 0.5 below the band, inside approachAtr
      [99, 99.3, 98.8, 99.1], // still next to it, not touching
    ]);
    expect(kinds(candles).slice(1)).toEqual([['broken', 20]]);
  });

  it('a multi-bar touch is one tested and one rejected', () => {
    const candles = series(110, [
      [104, 104, 100.1, 100.2], // tested, close inside the band
      [100.2, 100.4, 99.8, 100.0], // still touching
      [100.0, 102, 100.5, 101.8], // low above the band -> rejected
    ]);
    expect(kinds(candles).slice(1)).toEqual([
      ['tested', 20],
      ['rejected', 22],
    ]);
  });
});

describe('geometries', () => {
  it('a sloped line moves its band with the bar', () => {
    // Rising support from 90 at bar 0, +0.5 per bar: 100 at bar 20, 101 at bar 22.
    const level = support({ geometry: { kind: 'sloped', anchorIndex: 0, anchorPrice: 90, slopePerBar: 0.5 } });
    const candles = series(110, [
      [110, 110, 105, 106],
      [106, 106, 103, 103],
      [103, 103, 100.9, 102], // reaches 101 ± 0.3 at bar 22
    ]);
    const events = trackLevelInteractions(candles, [level], P).events;
    const tested = events.find((e) => e.payload!.kind === 'tested');
    expect(tested?.index).toBe(22);
    expect(tested?.payload?.price).toBeCloseTo(101, 10);
  });

  it('a zone uses its own bounds, not an ATR band', () => {
    const level = support({ geometry: { kind: 'zone', upper: 102, lower: 98 } });
    const candles = series(110, [[104, 104, 101.9, 103]]);
    const tested = trackLevelInteractions(candles, [level], P).events.find((e) => e.payload!.kind === 'tested');
    expect(tested?.payload).toMatchObject({ upper: 102, lower: 98 });
  });

  it('resistance mirrors support', () => {
    const level: LevelInput = { id: 'r100', geometry: { kind: 'horizontal', price: 100 }, role: 'resistance', knowableIndex: 19 };
    const candles = series(95, [
      [96, 99.5, 96, 99], // approached
      [99, 100.1, 98.5, 99], // tested + rejected (bearish)
      [99, 101.5, 99, 101], // broken (bullish)
    ]);
    expect(trackLevelInteractions(candles, [level], P).events.map((e) => [e.payload!.kind, e.payload!.direction])).toEqual([
      ['formed', 'neutral'],
      ['approached', 'neutral'],
      ['tested', 'neutral'],
      ['rejected', 'bearish'],
      ['broken', 'bullish'],
    ]);
  });
});

describe('contract', () => {
  it('ids are the prefix plus a published kind, with definitions to match', () => {
    expect(getEventDefinitions()).toEqual([]); // same zero-argument contract as every module
    const defs = eventDefinitionsFor('keyLevel', 'Key Level');
    expect(defs.map((d) => d.id)).toEqual(LEVEL_EVENT_KINDS.map((k) => `keyLevel.${k}`));
    expect(defs[0].name).toBe('Key Level Formed');
    expect(() => eventDefinitionsFor('bad prefix', 'x')).toThrow(TypeError);
  });

  it('nothing is judged before the level is knowable, and nothing before ATR exists', () => {
    const candles = series(100, [[100, 101, 99, 100]]);
    const late = kinds(candles, [support({ knowableIndex: 25 })]);
    expect(late).toEqual([]);
    const early = trackLevelInteractions(warm(100, 3), [support({ knowableIndex: 0 })], { idPrefix: 't', atrLength: 14 });
    expect(early.events.map((e) => e.payload!.kind)).toEqual(['formed']);
  });

  it('levels are independent: adding a level never changes another level\'s events', () => {
    const candles = series(110, [
      [104, 104, 100.8, 101],
      [101, 101.5, 99.9, 101.2],
      [101, 101, 98, 98.5],
    ]);
    const alone = trackLevelInteractions(candles, [support()], P).events;
    const other: LevelInput = { id: 'r105', geometry: { kind: 'horizontal', price: 105 }, role: 'resistance', knowableIndex: 19 };
    const together = trackLevelInteractions(candles, [support(), other], P).events.filter((e) => e.payload!.levelId === 's100');
    expect(together).toEqual(alone);
  });

  it('walk-forward: events from a prefix of the candles equal the full run\'s events before that bar', () => {
    const candles = series(103, [
      [104, 104, 100.8, 101], [101, 101.5, 99.9, 101.2], [101, 101, 98, 98.5],
      [98.5, 99, 97, 97.5], [97.5, 99.9, 97.4, 98], [98, 98, 95, 96],
    ]);
    const levels = [support(), { id: 'r104', geometry: { kind: 'horizontal', price: 104 }, role: 'resistance', knowableIndex: 19 } as LevelInput];
    const full = trackLevelInteractions(candles, levels, P).events;
    for (let n = 1; n <= candles.length; n += 1) {
      const prefix = trackLevelInteractions(candles.slice(0, n), levels, P).events;
      expect(prefix).toEqual(full.filter((e) => (e.index ?? 0) < n));
    }
  });

  it('payloads carry the state at the bar and the params hash', () => {
    const candles = series(103, [[101, 101, 98, 98.5]]);
    const [, broken] = trackLevelInteractions(candles, [support({ meta: { source: 'test' } })], P).events;
    expect(broken.payload).toMatchObject({
      levelId: 's100', kind: 'broken', role: 'resistance', confirmed: false, originalRole: 'support',
      close: 98.5, barsSinceFormed: 1, meta: { source: 'test' },
    });
    expect(broken.payload!.paramsHash).toMatch(/\S/);
    const other = trackLevelInteractions(candles, [support()], { ...P, breakAtr: 0.3 }).events[1];
    expect(other.payload!.paramsHash).not.toBe(broken.payload!.paramsHash);
  });

  it('validates params and levels', () => {
    expect(() => resolveLevelInteractionParams({ approachAtr: 1, approachResetAtr: 1 })).toThrow(TypeError);
    expect(() => resolveLevelInteractionParams({ reclaimBars: -1 })).toThrow(TypeError);
    expect(() => trackLevelInteractions([], [support(), support()], P)).toThrow(/Duplicate level id/);
    expect(() => trackLevelInteractions([], [support({ knowableIndex: -1 })], P)).toThrow(TypeError);
    expect(() => trackLevelInteractions([], [support({ geometry: { kind: 'zone', upper: 1, lower: 2 } })], P)).toThrow(TypeError);
  });
});

describe('keepNearestApproaches', () => {
  it('keeps the nearest approached level per bar and role, and every other event', () => {
    // Both supports sit within approach distance of the close on bar 20; neither is touched.
    const candles = series(102, [[102, 102, 101.15, 101.2]]);
    const levels: LevelInput[] = [support(), support({ id: 's100.8', geometry: { kind: 'horizontal', price: 100.8 } })];
    const { events } = trackLevelInteractions(candles, levels, P);
    const approached = (list: typeof events) => list.filter((e) => e.payload!.kind === 'approached').map((e) => e.payload!.levelId);
    expect(approached(events)).toEqual(['s100', 's100.8']);
    expect(approached(keepNearestApproaches(events))).toEqual(['s100.8']);
    expect(keepNearestApproaches(events).filter((e) => e.payload!.kind === 'formed')).toHaveLength(2);
  });
});
