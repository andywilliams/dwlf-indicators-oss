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

describe('standardDeviation precision (DWLF-337)', () => {
  it('is unchanged by a large constant shift, which the one-pass formula is not', () => {
    const base = Array.from({ length: 60 }, (_, i) => Math.sin(i / 3) * 7 + (i % 5));
    const shifted = base.map((v) => v + 1e9);
    const expected = standardDeviation(base, 20);
    standardDeviation(shifted, 20).forEach((value, i) => {
      if (expected[i] === undefined) {
        expect(value).toBeUndefined();
      } else {
        expect(value).toBeCloseTo(expected[i], 6);
      }
    });
  });
});
