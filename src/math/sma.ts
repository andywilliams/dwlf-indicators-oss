import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

export const sma = (
  values: Array<number | undefined>,
  period: number,
): Array<number | undefined> => {
  assertPositiveInteger(period, 'period');

  const result: Array<number | undefined> = Array.from({ length: values.length }, () => undefined);
  const buffer: number[] = Array.from({ length: period }, () => 0);
  let sum = 0;
  let filled = 0;
  let index = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];

    if (!isFiniteNumber(value)) {
      sum = 0;
      filled = 0;
      index = 0;
      continue;
    }

    if (filled < period) {
      buffer[filled] = value;
      sum += value;
      filled += 1;

      if (filled < period) {
        continue;
      }

      result[i] = sum / period;
      index = 0;
      continue;
    }

    const outgoing = buffer[index];
    buffer[index] = value;
    sum += value - outgoing;
    index = (index + 1) % period;
    result[i] = sum / period;
  }

  return result;
};
