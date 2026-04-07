import type { Candle } from '../../types';

type Direction = 'support' | 'resistance';

export type TrendlineLike = {
  type: Direction;
  startIndex: number;
  endIndex: number;
  startPrice: number;
  slope: number;
  activationIndex?: number;
  breachedAtIndex?: number;
};

export type TrendlineBreachDetail = {
  index: number;
  t: number;
  linePrice: number;
  close: number;
  extremePrice: number;
  breakType: 'support_break' | 'resistance_break';
};

export type TrendlineBreachEvaluation = {
  breaches: TrendlineBreachDetail[];
  breachCloses: TrendlineBreachDetail[];
};

export const getLinePriceAtIndex = (line: TrendlineLike, index: number): number =>
  line.startPrice + line.slope * (index - line.startIndex);

const isSupportBreakClose = (
  prevClose: number,
  currentClose: number,
  prevLinePrice: number,
  currentLinePrice: number,
): boolean => prevClose >= prevLinePrice && currentClose < currentLinePrice;

const isResistanceBreakClose = (
  prevClose: number,
  currentClose: number,
  prevLinePrice: number,
  currentLinePrice: number,
): boolean => prevClose <= prevLinePrice && currentClose > currentLinePrice;

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

  const startIndex = activationIndex;
  const breakType = line.type === 'support' ? 'support_break' : 'resistance_break';
  const isSupport = line.type === 'support';
  const evaluationAnchor = anchorIndex ?? line.startIndex;

  for (let index = startIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    const prevCandle = candles[index - 1];
    if (!candle || !prevCandle) {
      continue;
    }

    const linePrice = getLinePriceAtIndex(line, index);
    const prevLinePrice = getLinePriceAtIndex(line, index - 1);

    const prevExtreme = isSupport ? prevCandle.l : prevCandle.h;
    const prevClose = prevCandle.c;
    const prevExtremeOnSafeSide = isSupport
      ? prevExtreme >= prevLinePrice
      : prevExtreme <= prevLinePrice;
    const prevCloseOnSafeSide = isSupport
      ? prevClose >= prevLinePrice
      : prevClose <= prevLinePrice;

    const prevIndex = index - 1;

    const intradayEligible = prevIndex <= evaluationAnchor || prevExtremeOnSafeSide;
    const closeEligible = prevIndex <= evaluationAnchor || prevCloseOnSafeSide;

    if (!intradayEligible && !closeEligible && line.breachedAtIndex !== index) {
      continue;
    }

    const intradayBreach = isSupport ? candle.l < linePrice : candle.h > linePrice;
    let closeBreak = false;

    if (intradayBreach && intradayEligible) {
      result.breaches.push({
        index,
        t: candle.t,
        linePrice,
        close: candle.c,
        extremePrice: isSupport ? candle.l : candle.h,
        breakType,
      });
    }

    if (closeEligible) {
      closeBreak = isSupport
        ? isSupportBreakClose(prevCandle.c, candle.c, prevLinePrice, linePrice)
        : isResistanceBreakClose(prevCandle.c, candle.c, prevLinePrice, linePrice);
    }
    if (closeBreak) {
      result.breachCloses.push({
        index,
        t: candle.t,
        linePrice,
        close: candle.c,
        extremePrice: line.type === 'support' ? candle.l : candle.h,
        breakType,
      });
      break;
    }
  }

  return result;
};
