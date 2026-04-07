import type { Candle } from '../../types';
import type { SwingHigh, SwingLow } from './swing';

type SwingPoint = SwingHigh | SwingLow;

export type SwingSweepResult = {
  swing: SwingPoint;
  sweepIndex: number;
  sweepCandle: Candle;
  reclaimIndex: number;
  reclaimCandle: Candle;
  sweepPrice: number;
  reclaimPrice: number;
  barsToReclaim: number;
};

export const findFirstSweepAfterSwing = (
  candles: Candle[],
  swing: SwingPoint,
  maxBarsToReclaim: number,
  endIndexExclusive?: number,
): SwingSweepResult | null => {
  if (!candles.length) {
    return null;
  }

  if (!Number.isFinite(swing.price)) {
    return null;
  }

  const startIndex = Math.max(Math.min(swing.index + 1, candles.length - 1), 1);
  const endIndex = typeof endIndexExclusive === 'number'
    ? Math.min(Math.max(endIndexExclusive, startIndex), candles.length)
    : candles.length;

  let index = startIndex;

  while (index < endIndex) {
    const current = candles[index];
    if (!current) {
      index += 1;
      continue;
    }

    const sweepTriggered = swing.type === 'high'
      ? current.h > swing.price
      : current.l < swing.price;

    if (!sweepTriggered) {
      index += 1;
      continue;
    }

    const maxReclaimIndex = Math.min(
      index + Math.max(maxBarsToReclaim, 1) - 1,
      endIndex - 1,
    );

    for (let reclaimIndex = index; reclaimIndex <= maxReclaimIndex; reclaimIndex += 1) {
      const reclaimCandle = candles[reclaimIndex];
      if (!reclaimCandle) {
        continue;
      }

      const reclaimed = swing.type === 'high'
        ? reclaimCandle.c < swing.price
        : reclaimCandle.c > swing.price;

      if (reclaimed) {
        const sweepPrice = swing.type === 'high' ? current.h : current.l;
        const reclaimPrice = reclaimCandle.c;
        return {
          swing,
          sweepIndex: index,
          sweepCandle: current,
          reclaimIndex,
          reclaimCandle,
          sweepPrice,
          reclaimPrice,
          barsToReclaim: reclaimIndex - index + 1,
        };
      }
    }

    index += 1;
  }

  return null;
};
