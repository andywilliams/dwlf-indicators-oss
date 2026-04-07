import type { Candle } from '../../types';
import type { SwingHigh, SwingLow } from './swing';

type SwingPoint = SwingHigh | SwingLow;

export type SwingBreakResult = {
  swing: SwingPoint;
  breakIndex: number;
  breakCandle: Candle;
  previousCandle: Candle;
};

export const findFirstBreakAfterSwing = (
  candles: Candle[],
  swing: SwingPoint,
  endIndexExclusive?: number,
): SwingBreakResult | null => {
  if (!candles.length) {
    return null;
  }

  const startIndex = Math.max(Math.min(swing.index + 1, candles.length - 1), 1);
  const endIndex = typeof endIndexExclusive === 'number'
    ? Math.min(Math.max(endIndexExclusive, startIndex), candles.length)
    : candles.length;

  for (let index = startIndex; index < endIndex; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    if (!current || !previous) {
      continue;
    }

    if (swing.type === 'high') {
      if (previous.h <= swing.price && current.h > swing.price) {
        return {
          swing,
          breakIndex: index,
          breakCandle: current,
          previousCandle: previous,
        };
      }
    } else if (previous.l >= swing.price && current.l < swing.price) {
      return {
        swing,
        breakIndex: index,
        breakCandle: current,
        previousCandle: previous,
      };
    }
  }

  return null;
};
