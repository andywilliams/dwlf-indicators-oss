import { describe, expect, it } from 'vitest';

import { standardDeviation } from './stddev';

describe('standardDeviation', () => {
  it('computes a rolling standard deviation when enough data is present', () => {
    const values: Array<number | undefined> = [1, 2, 3, 4];
    const result = standardDeviation(values, 3);

    expect(result[0]).toBeUndefined();
    expect(result[1]).toBeUndefined();
    expect(result[2]).toBeCloseTo(Math.sqrt(2 / 3), 10);
    expect(result[3]).toBeCloseTo(Math.sqrt(2 / 3), 10);
  });

  it('resets the window when encountering non-finite values', () => {
    const values: Array<number | undefined> = [1, 2, 3, Number.NaN, 4, 5, 6];
    const result = standardDeviation(values, 3);

    expect(result[2]).toBeCloseTo(Math.sqrt(2 / 3), 10);
    expect(result[3]).toBeUndefined();
    expect(result[4]).toBeUndefined();
    expect(result[5]).toBeUndefined();
    expect(result[6]).toBeCloseTo(Math.sqrt(2 / 3), 10);
  });
});
