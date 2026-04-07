import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

export const standardDeviation = (
  values: Array<number | undefined>,
  period: number,
): Array<number | undefined> => {
  assertPositiveInteger(period, 'period');

  const result: Array<number | undefined> = Array.from({ length: values.length }, () => undefined);
  const buffer: number[] = Array.from({ length: period }, () => 0);
  let filled = 0;
  let index = 0;
  let sum = 0;
  let sumSquares = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];

    if (!isFiniteNumber(value)) {
      filled = 0;
      index = 0;
      sum = 0;
      sumSquares = 0;
      continue;
    }

    if (filled < period) {
      buffer[filled] = value;
      filled += 1;
      sum += value;
      sumSquares += value * value;

      if (filled < period) {
        continue;
      }

      index = 0;
    } else {
      const outgoing = buffer[index];
      buffer[index] = value;
      sum += value - outgoing;
      sumSquares += value * value - outgoing * outgoing;
      index = (index + 1) % period;
    }

    const mean = sum / period;
    const variance = sumSquares / period - mean * mean;
    result[i] = Math.sqrt(Math.max(variance, 0));
  }

  return result;
};
