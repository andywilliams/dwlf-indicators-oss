import type { Candle } from '../../types';
import { evaluateTrendlineBarBreach } from './breachBar';
import type { TrendlineBreachDetail, TrendlineLike } from './breachBar';

export { getLinePriceAtIndex } from './breachBar';
export type { TrendlineLike, TrendlineBreachDetail } from './breachBar';

export type TrendlineBreachEvaluation = {
  breaches: TrendlineBreachDetail[];
  breachCloses: TrendlineBreachDetail[];
};

export const evaluateTrendlineBreaches = (
  candles: Candle[],
  line: TrendlineLike,
): TrendlineBreachEvaluation => {
  const result: TrendlineBreachEvaluation = { breaches: [], breachCloses: [] };
  if (!candles.length) {
    return result;
  }

  const anchorIndex =
    line.activationIndex ?? (Number.isFinite(line.endIndex) ? line.endIndex : line.startIndex);

  const activationIndex = Math.max(
    Math.min((anchorIndex ?? line.startIndex) + 1, candles.length - 1),
    1,
  );
  if (activationIndex >= candles.length) {
    return result;
  }

  const evaluationAnchor = anchorIndex ?? line.startIndex;

  for (let index = activationIndex; index < candles.length; index += 1) {
    const { breach, breachClose } = evaluateTrendlineBarBreach(candles, line, index, evaluationAnchor);
    if (breach) {
      result.breaches.push(breach);
    }
    if (breachClose) {
      result.breachCloses.push(breachClose);
      break;
    }
  }

  return result;
};
