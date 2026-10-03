import type { Candle, IndicatorEvent, IndicatorEventDefinition } from '../../types';
import { atr as wilderAtr } from '../../math/atr';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { createIndicatorEvent } from '../../utils/events';
import { hashParams } from '../../utils/hash';

// How price interacts with levels a caller supplies. Design and the episode
// rules: docs/level-interaction.md.

export const LEVEL_EVENT_KINDS = [
  'formed',
  'approached',
  'tested',
  'rejected',
  'broken',
  'retested',
  'flipped',
  'reclaimed',
  'expired',
] as const;

export type LevelEventKind = (typeof LEVEL_EVENT_KINDS)[number];
export type LevelRole = 'support' | 'resistance';
export type LevelDirection = 'bullish' | 'bearish' | 'neutral';

export type LevelGeometry =
  | { kind: 'horizontal'; price: number }
  | { kind: 'sloped'; anchorIndex: number; anchorPrice: number; slopePerBar: number }
  | { kind: 'zone'; upper: number; lower: number };

export type LevelInput = {
  id: string;
  geometry: LevelGeometry;
  role: LevelRole;
  /** First bar whose close lets the caller know the level exists. */
  knowableIndex: number;
  /** The level stops existing after this bar. */
  endIndex?: number;
  meta?: Record<string, unknown>;
};

export type LevelInteractionParams = {
  atrLength?: number;
  /** Half-width of the band around a line, in ATR. Zones use their own bounds. */
  touchAtr?: number;
  /** A close within this many ATR of the band's near edge is an approach. */
  approachAtr?: number;
  /** An approach episode closes once the close is this many ATR from the band. */
  approachResetAtr?: number;
  /**
   * After a hold (rejected or flipped), a new touch episode needs the close to
   * have moved this many ATR away from the band first; touches before that are
   * the same episode continuing and fire nothing.
   */
  touchResetAtr?: number;
  /** A break needs a close this many ATR beyond the band's far edge. */
  breakAtr?: number;
  /** A close back through within this many bars of a break is a reclaim (failed break). */
  reclaimBars?: number;
  /** A level with no touch or break for this many bars expires. */
  expiryBars?: number;
};

export type ResolvedLevelInteractionParams = Required<LevelInteractionParams>;

export type LevelEventPayload = {
  levelId: string;
  kind: LevelEventKind;
  direction: LevelDirection;
  /** Role after this event. */
  role: LevelRole;
  confirmed: boolean;
  originalRole: LevelRole;
  /** The level's price at this bar (the zone's midpoint for a zone). */
  price: number;
  upper: number;
  lower: number;
  close: number;
  atr: number | null;
  /** Close's distance from the band's near edge, in ATR (0 inside the band). */
  distanceAtr: number | null;
  touches: number;
  barsSinceFormed: number;
  paramsHash: string;
  meta?: Record<string, unknown>;
};

export type LevelState = {
  levelId: string;
  role: LevelRole;
  confirmed: boolean;
  originalRole: LevelRole;
  phase: 'away' | 'touching';
  touches: number;
  expired: boolean;
  lastEventKind: LevelEventKind | null;
  lastEventIndex: number | null;
};

export type LevelInteractionResult = {
  events: IndicatorEvent<LevelEventPayload>[];
  states: LevelState[];
};

const DEFAULT_PARAMS: ResolvedLevelInteractionParams = {
  atrLength: 14,
  touchAtr: 0.15,
  approachAtr: 0.5,
  approachResetAtr: 1.0,
  touchResetAtr: 0.5,
  breakAtr: 0.25,
  reclaimBars: 5,
  expiryBars: 250,
};

const assertNonNegative = (value: number, name: string): void => {
  if (!isFiniteNumber(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number. Received: ${value}`);
  }
};

export const resolveLevelInteractionParams = (
  params: LevelInteractionParams = {},
): ResolvedLevelInteractionParams => {
  const resolved: ResolvedLevelInteractionParams = {
    atrLength: params.atrLength ?? DEFAULT_PARAMS.atrLength,
    touchAtr: params.touchAtr ?? DEFAULT_PARAMS.touchAtr,
    approachAtr: params.approachAtr ?? DEFAULT_PARAMS.approachAtr,
    approachResetAtr: params.approachResetAtr ?? DEFAULT_PARAMS.approachResetAtr,
    touchResetAtr: params.touchResetAtr ?? DEFAULT_PARAMS.touchResetAtr,
    breakAtr: params.breakAtr ?? DEFAULT_PARAMS.breakAtr,
    reclaimBars: params.reclaimBars ?? DEFAULT_PARAMS.reclaimBars,
    expiryBars: params.expiryBars ?? DEFAULT_PARAMS.expiryBars,
  };
  assertPositiveInteger(resolved.atrLength, 'atrLength');
  assertPositiveInteger(resolved.expiryBars, 'expiryBars');
  if (!Number.isInteger(resolved.reclaimBars) || resolved.reclaimBars < 0) {
    throw new TypeError(`reclaimBars must be a non-negative integer. Received: ${resolved.reclaimBars}`);
  }
  assertNonNegative(resolved.touchAtr, 'touchAtr');
  assertNonNegative(resolved.approachAtr, 'approachAtr');
  assertNonNegative(resolved.breakAtr, 'breakAtr');
  assertNonNegative(resolved.touchResetAtr, 'touchResetAtr');
  if (!isFiniteNumber(resolved.approachResetAtr) || resolved.approachResetAtr <= resolved.approachAtr) {
    throw new TypeError('approachResetAtr must be greater than approachAtr.');
  }
  return resolved;
};

const KIND_TEXT: Record<LevelEventKind, { name: string; description: string }> = {
  formed: { name: 'Formed', description: 'The level became known.' },
  approached: { name: 'Approached', description: 'Price closed near the level from its expected side.' },
  tested: { name: 'Tested', description: 'Price reached the level.' },
  rejected: { name: 'Rejected', description: 'Price left the level on its expected side: the level held.' },
  broken: { name: 'Broken', description: 'Price closed beyond the level by the break buffer.' },
  retested: { name: 'Retested', description: 'Price returned to a broken level from the other side.' },
  flipped: { name: 'Flipped', description: 'A broken level held from the other side: its role reversed.' },
  reclaimed: { name: 'Reclaimed', description: 'Price closed back through soon after a break: the break failed.' },
  expired: { name: 'Expired', description: 'The level ended, or went untouched for the expiry period.' },
};

const assertPrefix = (idPrefix: string): void => {
  if (typeof idPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(idPrefix)) {
    throw new TypeError(`idPrefix must be dot-separated identifiers. Received: ${idPrefix}`);
  }
};

/**
 * The event definitions for one consumer's prefix, e.g. `eventDefinitionsFor('keyLevel', 'Key Level')`.
 * Consumers register these under their own module in the platform's registry.
 */
export const eventDefinitionsFor = (idPrefix: string, label: string): IndicatorEventDefinition[] => {
  assertPrefix(idPrefix);
  return LEVEL_EVENT_KINDS.map((kind) => ({
    id: `${idPrefix}.${kind}`,
    name: `${label} ${KIND_TEXT[kind].name}`,
    description: KIND_TEXT[kind].description,
  }));
};

/**
 * Same zero-argument contract as every other module. This module emits nothing
 * under a name of its own (consumers choose the prefix), so the list is empty;
 * use `eventDefinitionsFor`.
 */
export const getEventDefinitions = (): IndicatorEventDefinition[] => [];

const opposite = (role: LevelRole): LevelRole => (role === 'support' ? 'resistance' : 'support');

const centerAt = (geometry: LevelGeometry, index: number): number => {
  switch (geometry.kind) {
    case 'horizontal':
      return geometry.price;
    case 'sloped':
      return geometry.anchorPrice + geometry.slopePerBar * (index - geometry.anchorIndex);
    case 'zone':
      return (geometry.upper + geometry.lower) / 2;
  }
};

const bandAt = (
  geometry: LevelGeometry,
  index: number,
  atr: number | undefined,
  touchAtr: number,
): { price: number; upper: number; lower: number } => {
  const price = centerAt(geometry, index);
  if (geometry.kind === 'zone') {
    return { price, upper: geometry.upper, lower: geometry.lower };
  }
  const half = isFiniteNumber(atr) ? touchAtr * atr : 0;
  return { price, upper: price + half, lower: price - half };
};

const assertLevel = (level: LevelInput): void => {
  if (typeof level.id !== 'string' || level.id.length === 0) {
    throw new TypeError('Every level needs a non-empty id.');
  }
  if (level.role !== 'support' && level.role !== 'resistance') {
    throw new TypeError(`Level ${level.id}: role must be support or resistance.`);
  }
  if (!Number.isInteger(level.knowableIndex) || level.knowableIndex < 0) {
    throw new TypeError(`Level ${level.id}: knowableIndex must be a non-negative integer.`);
  }
  if (level.endIndex !== undefined && (!Number.isInteger(level.endIndex) || level.endIndex < level.knowableIndex)) {
    throw new TypeError(`Level ${level.id}: endIndex must be an integer at or after knowableIndex.`);
  }
  const g = level.geometry;
  const finite =
    g?.kind === 'horizontal'
      ? isFiniteNumber(g.price)
      : g?.kind === 'sloped'
        ? Number.isInteger(g.anchorIndex) && isFiniteNumber(g.anchorPrice) && isFiniteNumber(g.slopePerBar)
        : g?.kind === 'zone'
          ? isFiniteNumber(g.upper) && isFiniteNumber(g.lower) && g.upper >= g.lower
          : false;
  if (!finite) {
    throw new TypeError(`Level ${level.id}: geometry is not a valid horizontal, sloped or zone level.`);
  }
};

type Walk = {
  level: LevelInput;
  candles: Candle[];
  atrSeries: Array<number | undefined>;
  params: ResolvedLevelInteractionParams;
  paramsHash: string;
  kindId: (kind: LevelEventKind) => IndicatorEventDefinition;
};

const walkLevel = ({ level, candles, atrSeries, params, paramsHash, kindId }: Walk) => {
  const events: IndicatorEvent<LevelEventPayload>[] = [];
  const state: LevelState = {
    levelId: level.id,
    role: level.role,
    confirmed: true,
    originalRole: level.role,
    phase: 'away',
    touches: 0,
    expired: false,
    lastEventKind: null,
    lastEventIndex: null,
  };
  if (level.knowableIndex >= candles.length) {
    return { events, state };
  }

  let breakIndex: number | null = null;
  let lastInteraction = level.knowableIndex;
  let approachOpen = false;
  // False after a hold until the close moves touchResetAtr away from the band.
  let armed = true;

  const emit = (
    kind: LevelEventKind,
    index: number,
    direction: LevelDirection,
    band: { price: number; upper: number; lower: number },
    distanceAtr: number | null,
  ) => {
    const atr = atrSeries[index];
    state.lastEventKind = kind;
    state.lastEventIndex = index;
    events.push(
      createIndicatorEvent(kindId(kind), {
        candle: candles[index],
        index,
        payload: {
          levelId: level.id,
          kind,
          direction,
          role: state.role,
          confirmed: state.confirmed,
          originalRole: state.originalRole,
          price: band.price,
          upper: band.upper,
          lower: band.lower,
          close: candles[index].c,
          atr: isFiniteNumber(atr) ? atr : null,
          distanceAtr,
          touches: state.touches,
          barsSinceFormed: index - level.knowableIndex,
          paramsHash,
          ...(level.meta ? { meta: level.meta } : {}),
        },
      }),
    );
  };

  // Judges one bar. Returns whether price interacted with the level (a touch or
  // a close through it), which is what keeps a level from expiring.
  const step = (i: number, band: { price: number; upper: number; lower: number }): boolean => {
    const atr = atrSeries[i];
    const { h, l, c } = candles[i];
    if (!isFiniteNumber(atr) || !isFiniteNumber(h) || !isFiniteNumber(l) || !isFiniteNumber(c)) {
      return false; // ATR warm-up or a bad candle: nothing is judged on this bar.
    }

    const isSupport = state.role === 'support';
    const buffer = params.breakAtr * atr;
    const beyond = isSupport ? c < band.lower - buffer : c > band.upper + buffer;

    if (beyond) {
      // The direction price went through the level.
      const direction: LevelDirection = isSupport ? 'bearish' : 'bullish';
      // A close back through within reclaimBars of a break is a failed break,
      // whether or not a quick retest already flipped the role.
      const reclaim = breakIndex !== null && i - breakIndex <= params.reclaimBars;
      state.role = opposite(state.role);
      state.phase = 'away';
      approachOpen = true; // price has just come through the level: no fresh approach
      armed = true;
      if (reclaim) {
        state.confirmed = true;
        breakIndex = null;
        emit('reclaimed', i, direction, band, 0);
      } else {
        state.confirmed = false;
        breakIndex = i;
        emit('broken', i, direction, band, 0);
      }
      return true;
    }

    const touching = isSupport ? l <= band.upper : h >= band.lower;
    const closedAway = isSupport ? c > band.upper : c < band.lower;
    // The direction a hold implies: a support holding is bullish.
    const holdDirection: LevelDirection = isSupport ? 'bullish' : 'bearish';
    const distanceAtr = (isSupport ? c - band.upper : band.lower - c) / atr;

    if (touching && !armed) {
      return true; // still hovering at the level after a hold: the same episode
    }

    if (touching && state.phase === 'away') {
      state.phase = 'touching';
      if (state.confirmed) {
        state.touches += 1;
        emit('tested', i, 'neutral', band, 0);
      } else {
        emit('retested', i, 'neutral', band, 0);
      }
    }
    if (touching && !closedAway) {
      approachOpen = false;
      return true;
    }

    if (state.phase === 'touching') {
      // The touch episode ends with the close back on the level's expected side.
      // The bar's own close decides whether the next touch is a new episode.
      state.phase = 'away';
      armed = distanceAtr > params.touchResetAtr;
      approachOpen = distanceAtr <= params.approachResetAtr;
      if (state.confirmed) {
        emit('rejected', i, holdDirection, band, 0);
      } else {
        state.confirmed = true;
        emit('flipped', i, holdDirection, band, 0);
      }
      return touching;
    }

    if (!armed && distanceAtr > params.touchResetAtr) {
      armed = true;
    }
    if (approachOpen) {
      if (distanceAtr > params.approachResetAtr) {
        approachOpen = false;
      }
    } else if (distanceAtr <= params.approachAtr) {
      approachOpen = true;
      emit('approached', i, 'neutral', band, distanceAtr);
    }
    return false;
  };

  // Expiry is known at the close of the bar that ends the level (its endIndex),
  // or of the expiryBars-th bar without an interaction.
  const expireIfDue = (i: number, band: { price: number; upper: number; lower: number }): boolean => {
    const ended = level.endIndex !== undefined && i >= level.endIndex;
    if (!ended && i - lastInteraction < params.expiryBars) {
      return false;
    }
    state.expired = true;
    emit('expired', i, 'neutral', band, null);
    return true;
  };

  const formedIndex = level.knowableIndex;
  const formedBand = bandAt(level.geometry, formedIndex, atrSeries[formedIndex], params.touchAtr);
  emit('formed', formedIndex, 'neutral', formedBand, null);
  if (expireIfDue(formedIndex, formedBand)) {
    return { events, state };
  }

  for (let i = formedIndex + 1; i < candles.length; i += 1) {
    const band = bandAt(level.geometry, i, atrSeries[i], params.touchAtr);
    if (step(i, band)) {
      lastInteraction = i;
    }
    if (expireIfDue(i, band)) {
      break;
    }
  }

  return { events, state };
};

/**
 * Walks `candles` once per level and reports how price interacted with it.
 * Levels are independent: one level's events never depend on the others passed
 * with it. Events are sorted by bar, then by level order in `levels`.
 */
export const trackLevelInteractions = (
  candles: Candle[],
  levels: LevelInput[],
  options: LevelInteractionParams & { idPrefix: string; label?: string },
): LevelInteractionResult => {
  const { idPrefix, label, ...rawParams } = options;
  assertPrefix(idPrefix);
  const params = resolveLevelInteractionParams(rawParams);
  const seen = new Set<string>();
  for (const level of levels) {
    assertLevel(level);
    if (seen.has(level.id)) {
      throw new TypeError(`Duplicate level id: ${level.id}`);
    }
    seen.add(level.id);
  }

  const definitions = new Map(
    eventDefinitionsFor(idPrefix, label ?? idPrefix).map((d) => [d.id.slice(idPrefix.length + 1), d]),
  );
  const kindId = (kind: LevelEventKind) => definitions.get(kind) as IndicatorEventDefinition;
  const atrSeries = candles.length ? wilderAtr(candles, params.atrLength) : [];
  const paramsHash = hashParams(params);

  const walks = levels.map((level) =>
    walkLevel({ level, candles, atrSeries, params, paramsHash, kindId }),
  );
  const order = new Map(levels.map((level, i) => [level.id, i]));
  const events = walks
    .flatMap((w) => w.events)
    .sort(
      (a, b) =>
        (a.index ?? 0) - (b.index ?? 0)
        || (order.get(a.payload?.levelId ?? '') ?? 0) - (order.get(b.payload?.levelId ?? '') ?? 0),
    );
  return { events, states: walks.map((w) => w.state) };
};

/**
 * Optional consumer-side filter: of the `approached` events on one bar for one
 * role, keeps only the nearest (smallest distanceAtr). Every other event passes.
 */
export const keepNearestApproaches = (
  events: IndicatorEvent<LevelEventPayload>[],
): IndicatorEvent<LevelEventPayload>[] => {
  const nearest = new Map<string, IndicatorEvent<LevelEventPayload>>();
  for (const event of events) {
    if (event.payload?.kind !== 'approached') continue;
    const key = `${event.index}:${event.payload.role}`;
    const current = nearest.get(key);
    if (!current || (event.payload.distanceAtr ?? Infinity) < (current.payload?.distanceAtr ?? Infinity)) {
      nearest.set(key, event);
    }
  }
  return events.filter(
    (event) => event.payload?.kind !== 'approached' || nearest.get(`${event.index}:${event.payload.role}`) === event,
  );
};
