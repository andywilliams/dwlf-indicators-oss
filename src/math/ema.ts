import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

export const ema = (
  values: Array<number | undefined>,
  period: number,
): Array<number | undefined> => {
  assertPositiveInteger(period, 'period');

  const result: Array<number | undefined> = Array.from({ length: values.length }, () => undefined);
  const multiplier = 2 / (period + 1);
  const seed: number[] = [];
  let prev: number | undefined;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];

    if (!isFiniteNumber(value)) {
      seed.length = 0;
      prev = undefined;
      continue;
    }

    if (prev === undefined) {
      seed.push(value);
      if (seed.length < period) {
        continue;
      }
      prev = seed.reduce((sum, entry) => sum + entry, 0) / period;
      result[i] = prev;
      continue;
    }

    prev = (value - prev) * multiplier + prev;
    result[i] = prev;
  }

  return result;
};

