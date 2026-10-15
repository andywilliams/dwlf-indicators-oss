import type { Candle, IndicatorEvent, IndicatorEventDefinition, LinePoint } from '../../types';
import { assertPositiveInteger, isFiniteNumber } from '../../utils/guards';
import { createIndicatorEvent } from '../../utils/events';
import { hashParams } from '../../utils/hash';

export type DivergenceSide = 'low' | 'high';
export type DivergenceKind = 'regular' | 'hidden';
export type DivergenceDirection = 'bullish' | 'bearish';

export type DivergencePivot = {
  side: DivergenceSide;
  /** The pivot bar. */
  index: number;
  /** First bar at which the caller could know the pivot (>= index). */
  knowableIndex: number;
  /** Defaults to the candle's low (side low) or high (side high). */
  price?: number;
};

export type DivergenceParams = {
  /** Caller-owned id prefix: 'rsi' gives 'rsi.divergence.regular.bullish'. */
  idPrefix: string;
  /** Fewest bars between the two pivots, inclusive. */
  minBars?: number;
  /** Most bars between the two pivots, inclusive. */
  maxBars?: number;
  /** The oscillator must differ by more than this between the pivots. */
  minOscillatorDelta?: number;
  /** Opaque description of the oscillator and pivot source; hashed and copied to payloads. */
  source?: Record<string, unknown>;
};

export type ResolvedDivergenceParams = Required<DivergenceParams>;

export type DivergencePayload = {
  kind: DivergenceKind;
  direction: DivergenceDirection;
  side: DivergenceSide;
  pivotIndex: number;
  pivotTime: number;
  pivotPrice: number;
  oscillatorValue: number;
  previousPivotIndex: number;
  previousPivotTime: number;
  previousPivotPrice: number;
  previousOscillatorValue: number;
  barsBetween: number;
  source: Record<string, unknown>;
  paramsHash: string;
};

export const DIVERGENCE_TYPES = [
  { kind: 'regular', direction: 'bullish' },
  { kind: 'hidden', direction: 'bullish' },
  { kind: 'regular', direction: 'bearish' },
  { kind: 'hidden', direction: 'bearish' },
] as const satisfies ReadonlyArray<{ kind: DivergenceKind; direction: DivergenceDirection }>;

const TYPE_TEXT: Record<`${DivergenceKind}.${DivergenceDirection}`, { name: string; description: string }> = {
  'regular.bullish': {
    name: 'Bullish Divergence',
    description: 'Price made a lower low while the oscillator made a higher low.',
  },
  'hidden.bullish': {
    name: 'Hidden Bullish Divergence',
    description: 'Price made a higher low while the oscillator made a lower low.',
  },
  'regular.bearish': {
    name: 'Bearish Divergence',
    description: 'Price made a higher high while the oscillator made a lower high.',
  },
  'hidden.bearish': {
    name: 'Hidden Bearish Divergence',
    description: 'Price made a lower high while the oscillator made a higher high.',
  },
};

const STAMP_NOTE = ' Stamped at the bar the later pivot became knowable.';

const assertPrefix = (idPrefix: string): void => {
  if (typeof idPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(idPrefix)) {
    throw new TypeError(`idPrefix must be dot-separated identifiers. Received: ${idPrefix}`);
  }
};

const definitionFor = (
  idPrefix: string,
  kind: DivergenceKind,
  direction: DivergenceDirection,
  label?: string,
): IndicatorEventDefinition => {
  const text = TYPE_TEXT[`${kind}.${direction}`];
  return {
    id: `${idPrefix}.divergence.${kind}.${direction}`,
    name: label ? `${label} ${text.name}` : text.name,
    description: `${text.description}${STAMP_NOTE}`,
  };
};

/**
 * The event definitions for one oscillator's prefix, e.g. `eventDefinitionsFor('rsi', 'RSI')`.
 * Consumers register these under their own module in the platform's registry.
 */
export const eventDefinitionsFor = (idPrefix: string, label: string): IndicatorEventDefinition[] => {
  assertPrefix(idPrefix);
  return DIVERGENCE_TYPES.map(({ kind, direction }) => definitionFor(idPrefix, kind, direction, label));
};

/**
 * Same zero-argument contract as every other module. This module emits nothing
 * under a name of its own (callers choose the prefix), so the list is empty;
 * use `eventDefinitionsFor`.
 */
export const getEventDefinitions = (): IndicatorEventDefinition[] => [];

export const resolveDivergenceParams = (params: DivergenceParams): ResolvedDivergenceParams => {
  const resolved: ResolvedDivergenceParams = {
    idPrefix: params?.idPrefix,
    minBars: params?.minBars ?? 5,
    maxBars: params?.maxBars ?? 120,
    minOscillatorDelta: params?.minOscillatorDelta ?? 0,
    source: params?.source ?? {},
  };

  assertPrefix(resolved.idPrefix);
  assertPositiveInteger(resolved.minBars, 'minBars');
  assertPositiveInteger(resolved.maxBars, 'maxBars');
  if (resolved.maxBars < resolved.minBars) {
    throw new TypeError(`maxBars must be at least minBars. Received: ${resolved.maxBars} < ${resolved.minBars}`);
  }
  if (!isFiniteNumber(resolved.minOscillatorDelta) || resolved.minOscillatorDelta < 0) {
    throw new TypeError(`minOscillatorDelta must be a non-negative number. Received: ${resolved.minOscillatorDelta}`);
  }
  if (resolved.source === null || typeof resolved.source !== 'object' || Array.isArray(resolved.source)) {
    throw new TypeError('source must be a plain object.');
  }

  return resolved;
};

type ResolvedPivot = { side: DivergenceSide; index: number; knowableIndex: number; price: number; value: number };

const classify = (
  previous: ResolvedPivot,
  current: ResolvedPivot,
  delta: number,
): { kind: DivergenceKind; direction: DivergenceDirection } | undefined => {
  const oscillatorUp = current.value > previous.value + delta;
  const oscillatorDown = current.value < previous.value - delta;
  if (current.side === 'low') {
    if (current.price < previous.price && oscillatorUp) {
      return { kind: 'regular', direction: 'bullish' };
    }
    if (current.price > previous.price && oscillatorDown) {
      return { kind: 'hidden', direction: 'bullish' };
    }
    return undefined;
  }
  if (current.price > previous.price && oscillatorDown) {
    return { kind: 'regular', direction: 'bearish' };
  }
  if (current.price < previous.price && oscillatorUp) {
    return { kind: 'hidden', direction: 'bearish' };
  }
  return undefined;
};

const resolvePivots = (candles: Candle[], oscillator: LinePoint[], pivots: DivergencePivot[]): ResolvedPivot[] => {
  const valueAt = new Map<number, number>();
  for (const point of oscillator) {
    if (isFiniteNumber(point?.t) && isFiniteNumber(point?.v)) {
      valueAt.set(point.t, point.v);
    }
  }

  const resolved: ResolvedPivot[] = [];
  for (const pivot of pivots) {
    const { side, index, knowableIndex } = pivot ?? {};
    if (
      (side !== 'low' && side !== 'high')
      || !Number.isInteger(index)
      || !Number.isInteger(knowableIndex)
      || index < 0
      || index >= candles.length
      || knowableIndex < index
    ) {
      continue;
    }
    const candle = candles[index];
    const price = pivot.price ?? (side === 'low' ? candle.l : candle.h);
    const value = valueAt.get(candle.t);
    if (!isFiniteNumber(price) || !isFiniteNumber(value)) {
      continue;
    }
    resolved.push({ side, index, knowableIndex, price, value });
  }
  return resolved;
};

/**
 * Compares each pivot with the previous pivot on the same side and fires when
 * price and the oscillator disagree:
 * - lows: lower low + higher oscillator low is regular bullish; higher low + lower oscillator low is hidden bullish.
 * - highs: higher high + lower oscillator high is regular bearish; lower high + higher oscillator high is hidden bearish.
 *
 * The oscillator (any `LinePoint[]`, e.g. `computeRsi(...).rsi`) is aligned to
 * `candles` by `t` and read at each pivot bar; a trailing oscillator's value
 * there uses no later candle. The event is stamped at the later pivot's
 * `knowableIndex`, and skipped when that bar is not in `candles`. The previous
 * pivot is the latest same-side one (by bar) already knowable at that bar, so
 * the result at any bar depends only on pivots knowable by then. A pivot whose
 * bar has no oscillator value or no finite price is skipped and never compared with.
 */
export const detectDivergences = (
  candles: Candle[],
  oscillator: LinePoint[],
  pivots: DivergencePivot[],
  params: DivergenceParams,
): IndicatorEvent<DivergencePayload>[] => {
  const resolved = resolveDivergenceParams(params);
  const paramsHash = hashParams(resolved);
  const usable = resolvePivots(candles, oscillator, pivots);
  const events: IndicatorEvent<DivergencePayload>[] = [];

  for (const current of usable) {
    if (current.knowableIndex >= candles.length) {
      continue;
    }
    let previous: ResolvedPivot | undefined;
    for (const candidate of usable) {
      if (
        candidate.side === current.side
        && candidate.index < current.index
        && candidate.knowableIndex <= current.knowableIndex
        && (!previous || candidate.index > previous.index)
      ) {
        previous = candidate;
      }
    }
    if (!previous) {
      continue;
    }
    const barsBetween = current.index - previous.index;
    if (barsBetween < resolved.minBars || barsBetween > resolved.maxBars) {
      continue;
    }
    const type = classify(previous, current, resolved.minOscillatorDelta);
    if (!type) {
      continue;
    }
    events.push(
      createIndicatorEvent(definitionFor(resolved.idPrefix, type.kind, type.direction), {
        candle: candles[current.knowableIndex],
        index: current.knowableIndex,
        payload: {
          kind: type.kind,
          direction: type.direction,
          side: current.side,
          pivotIndex: current.index,
          pivotTime: candles[current.index].t,
          pivotPrice: current.price,
          oscillatorValue: current.value,
          previousPivotIndex: previous.index,
          previousPivotTime: candles[previous.index].t,
          previousPivotPrice: previous.price,
          previousOscillatorValue: previous.value,
          barsBetween,
          source: resolved.source,
          paramsHash,
        },
      }),
    );
  }

  return events.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || (a.payload?.pivotIndex ?? 0) - (b.payload?.pivotIndex ?? 0));
};
