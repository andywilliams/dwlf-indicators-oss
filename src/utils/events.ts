import type { Candle, IndicatorEvent, IndicatorEventDefinition } from '../types';

export type IndicatorEventContext<TPayload = Record<string, unknown>> = {
  index?: number;
  candle?: Candle;
  t?: number;
  payload?: TPayload;
};

export const createIndicatorEvent = <TPayload = Record<string, unknown>>(
  definition: IndicatorEventDefinition,
  context: IndicatorEventContext<TPayload> = {},
): IndicatorEvent<TPayload> => {
  const { candle, index, payload } = context;
  const timestamp = context.t ?? candle?.t;

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    candle,
    index,
    t: timestamp,
    payload,
  };
};
