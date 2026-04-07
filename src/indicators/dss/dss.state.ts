import type { Candle, DssParams, LinePoint } from '../../types';
import { computeDSS, resolveDssParams, type ResolvedDssParams } from './dss';

export type DssState = {
  params: ResolvedDssParams;
  candles: Candle[];
};

export const initDSS = (params?: DssParams): DssState => ({
  params: resolveDssParams(params),
  candles: [],
});

export type UpdateDssResult = {
  state: DssState;
  dssPoint?: LinePoint;
  signalPoint?: LinePoint;
};

export const updateDSS = (state: DssState, newCandles: Candle[]): UpdateDssResult => {
  if (newCandles.length === 0) {
    return { state };
  }

  const lastTimestamp = state.candles.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
  let cursor = lastTimestamp;
  for (const candle of newCandles) {
    if (candle.t < cursor) {
      throw new Error('Candles must be provided in non-decreasing timestamp order.');
    }
    cursor = candle.t;
  }

  const merged = [...state.candles, ...newCandles];
  const nextState: DssState = {
    params: state.params,
    candles: merged,
  };

  const result = computeDSS(nextState.candles, state.params);
  const newestTimestamp = newCandles.at(-1)?.t;
  const dssPoint = result.dss.at(-1);
  const signalPoint = result.signal.at(-1);

  return {
    state: nextState,
    dssPoint: dssPoint && dssPoint.t === newestTimestamp ? dssPoint : undefined,
    signalPoint:
      signalPoint && signalPoint.t === newestTimestamp ? signalPoint : undefined,
  };
};

