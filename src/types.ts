export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

export type LinePoint = {
  t: number;
  v: number;
};

export type SwingParams = {
  lookback?: number;
};

export type BollingerParams = {
  length?: number;
  basis?: 'sma' | 'ema';
  source?: 'open' | 'high' | 'low' | 'close';
  standardDeviation?: number;
  offset?: number;
};

export type AtrParams = {
  /** Wilder smoothing period. */
  length?: number;
  /** Trailing bars the ATR% percentile is ranked against. */
  percentileWindow?: number;
  /** Percentile (0-100, exclusive) whose upward crossing fires `atr.regime.expansion`. */
  expansionPercentile?: number;
  /** Percentile (0-100, exclusive) whose downward crossing fires `atr.regime.contraction`. */
  contractionPercentile?: number;
  /** Percentile an episode must return past before its event can fire again. */
  episodeResetPercentile?: number;
};

export type DssParams = {
  length?: number;
  smooth1?: number;
  signal?: number;
};

export type IndicatorEventDefinition = {
  /**
   * Stable identifier for the event (e.g. "swing.high").
   */
  id: string;
  /**
   * Human-friendly title describing the event.
   */
  name: string;
  /**
   * Short explanation of when the event is emitted.
   */
  description: string;
};

export type IndicatorEvent<TPayload = Record<string, unknown>> = IndicatorEventDefinition & {
  /**
   * Optional candle index relative to the input series.
   */
  index?: number;
  /**
   * Candle associated with the event, when applicable.
   */
  candle?: Candle;
  /**
   * Timestamp of the event; defaults to the candle timestamp when provided.
   */
  t?: number;
  /**
   * Structured data describing the event outcome.
   */
  payload?: TPayload;
};
