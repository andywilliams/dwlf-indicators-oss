import { assertPositiveInteger, isFiniteNumber } from '../utils/guards';

/**
 * Population standard deviation of one full window, two-pass: the mean first,
 * then the squared deviations from it. The one-pass `sumSq/n − mean²` cancels
 * catastrophically when the values are large relative to their spread (BTC-scale
 * prices), and a running sum drifts over a long series.
 */
const windowDeviation = (window: number[]): number => {
  let sum = 0;
  for (const value of window) {
    sum += value;
  }
  const mean = sum / window.length;
  let squares = 0;
  for (const value of window) {
    squares += (value - mean) * (value - mean);
  }
  return Math.sqrt(squares / window.length);
};

export const standardDeviation = (
  values: Array<number | undefined>,
  period: number,
): Array<number | undefined> => {
  assertPositiveInteger(period, 'period');

  const result: Array<number | undefined> = Array.from({ length: values.length }, () => undefined);
  const buffer: number[] = Array.from({ length: period }, () => 0);
  let filled = 0;
  let index = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];

    if (!isFiniteNumber(value)) {
      filled = 0;
      index = 0;
      continue;
    }

    if (filled < period) {
      buffer[filled] = value;
      filled += 1;

      if (filled < period) {
        continue;
      }

      index = 0;
    } else {
      buffer[index] = value;
      index = (index + 1) % period;
    }

    result[i] = windowDeviation(buffer);
  }

  return result;
};
