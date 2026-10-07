import type { Candle } from '../../types';

// Internal: the per-bar breach rule, shared by evaluateTrendlineBreaches and
// TrendlineV1's live replay. Not re-exported from the BreachDetection
// namespace, so it is not public API.

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

export type TrendlineBarBreach = {
  breach?: TrendlineBreachDetail;
  breachClose?: TrendlineBreachDetail;
};

/**
 * Whether bar `index` breaches `line`, from that bar and the one before it
 * alone. `evaluationAnchor` is the bar the line was anchored on: until the bar
 * after it, the previous bar need not sit on the line's safe side.
 */
export const evaluateTrendlineBarBreach = (
  candles: Candle[],
  line: TrendlineLike,
  index: number,
  evaluationAnchor: number,
): TrendlineBarBreach => {
  const candle = candles[index];
  const prevCandle = candles[index - 1];
  if (!candle || !prevCandle) {
    return {};
  }

  const breakType = line.type === 'support' ? 'support_break' : 'resistance_break';
  const isSupport = line.type === 'support';
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
    return {};
  }

  const result: TrendlineBarBreach = {};
  const intradayBreach = isSupport ? candle.l < linePrice : candle.h > linePrice;
  if (intradayBreach && intradayEligible) {
    result.breach = {
      index,
      t: candle.t,
      linePrice,
      close: candle.c,
      extremePrice: isSupport ? candle.l : candle.h,
      breakType,
    };
  }

  const closeBreak = closeEligible
    && (isSupport
      ? isSupportBreakClose(prevCandle.c, candle.c, prevLinePrice, linePrice)
      : isResistanceBreakClose(prevCandle.c, candle.c, prevLinePrice, linePrice));
  if (closeBreak) {
    result.breachClose = {
      index,
      t: candle.t,
      linePrice,
      close: candle.c,
      extremePrice: isSupport ? candle.l : candle.h,
      breakType,
    };
  }
  return result;
};

