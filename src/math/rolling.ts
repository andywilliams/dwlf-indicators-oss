import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

const deriveStart = (index: number, length: number): number => Math.max(0, index - length + 1);

const ensureValue = (value: number | undefined, fallback: number): number =>
  isFiniteNumber(value) ? value : fallback;

const traverseWindow = (
  values: number[],
  index: number,
  length: number,
  predicate: (accumulator: number, value: number) => number,
  seed: number,
): number => {
  assertPositiveInteger(length, 'length');
  if (index < 0 || index >= values.length) {
    throw new RangeError(`index ${index} is out of bounds for array of length ${values.length}`);
  }

  let computed = seed;
  let seen = false;
  const start = deriveStart(index, length);

  for (let i = start; i <= index; i += 1) {
    const current = values[i];
    if (!isFiniteNumber(current)) {
      continue;
    }
    if (!seen) {
      computed = current;
      seen = true;
      continue;
    }
    computed = predicate(computed, current);
  }

  if (!seen) {
    const fallback = ensureValue(values[index], 0);
    return fallback;
  }

  return computed;
};

export const rollingHighest = (values: number[], index: number, length: number): number =>
  traverseWindow(
    values,
    index,
    length,
    (accumulator, value) => (value > accumulator ? value : accumulator),
    Number.NEGATIVE_INFINITY,
  );

export const rollingLowest = (values: number[], index: number, length: number): number =>
  traverseWindow(
    values,
    index,
    length,
    (accumulator, value) => (value < accumulator ? value : accumulator),
    Number.POSITIVE_INFINITY,
  );

