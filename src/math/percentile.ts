import { isFiniteNumber } from '../utils/guards';

/**
 * Percentile rank (0-100) of each value within the trailing `window` values
 * ending at it, by midrank: values below count fully and ties (the value
 * itself included) count half, so a flat window ranks 50, not 100.
 * A bar's rank is undefined until a full window has passed since the first
 * finite value (so warm-up is never ranked), and while fewer than half the
 * window's values are finite. Later gaps are left out of the ranking.
 */
export const trailingPercentileRank = (values: Array<number | undefined>, window: number): Array<number | undefined> => {
  const first = values.findIndex((v) => isFiniteNumber(v));
  return values.map((value, i) => {
    if (!isFiniteNumber(value) || first < 0 || i - window + 1 < first) {
      return undefined;
    }
    let below = 0;
    let ties = 0;
    let counted = 0;
    for (let j = i - window + 1; j <= i; j += 1) {
      const other = values[j];
      if (!isFiniteNumber(other)) {
        continue;
      }
      counted += 1;
      if (other < value) {
        below += 1;
      } else if (other === value) {
        ties += 1;
      }
    }
    if (counted * 2 < window) {
      return undefined;
    }
    return ((below + ties / 2) / counted) * 100;
  });
};
