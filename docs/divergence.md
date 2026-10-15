# RSI and divergence

Status: design (DWLF-338). Modules: `RSI` (`src/indicators/rsi/`), `Divergence` (`src/indicators/divergence/`).

## Why

Divergence at a cycle low is the classic confirmation cycle traders look for: price makes a lower
low while momentum makes a higher low. Nothing in the library detects it today (the private cycle
scorer credits a "divergent" DSS touch internally, but publishes no event). RSI is the most-expected
oscillator, and nothing computes it.

## RSI

Wilder's RSI on closes (`math/rsi.ts`): the first `length` close-to-close changes seed the average
gain and loss with their simple mean; after that `avg = (avg * (length - 1) + x) / length`.
`avgLoss = 0` gives 100 (50 when both averages are 0). A non-finite close restarts the seed, as
`math/atr.ts` does.

```ts
computeRsi(candles, { length = 14, overbought = 70, oversold = 30, midline = 50 })
  => { rsi: LinePoint[]; params }
detectEvents(candles, params) => IndicatorEvent<RsiEventPayload>[]
getEventDefinitions()
```

Events, each on the bar whose close completes the crossing. Exits match `dss.exit.*` (a value on the
level counts as back inside; payload `threshold` and `zone`); the midline cross is `rsi.midline.*`, not `rsi.cross.*`, because `dss.cross.*` means a
signal-line cross and RSI has no signal line (that id stays free for one):

| id | when |
|---|---|
| `rsi.exit.overbought` | previous > `overbought`, current ≤ `overbought` |
| `rsi.exit.oversold` | previous < `oversold`, current ≥ `oversold` |
| `rsi.midline.bullish` | previous < `midline`, current ≥ `midline` |
| `rsi.midline.bearish` | previous ≥ `midline`, current < `midline` |

Exits, not entries: "left oversold" is the actionable read (the 2-Oct review); entries would double
the count for little. Payload: `{ rsi, previous, threshold, zone (exits only), length }`.

## Divergence

Generic: the caller supplies the oscillator and the pivots, so the same machine serves RSI, DSS and
later OBV/MACD, and serves cycle pivots on the platform or swing pivots elsewhere.

```ts
type DivergencePivot = {
  side: 'low' | 'high';
  index: number;          // the pivot bar
  knowableIndex: number;  // first bar at which the caller could know the pivot (>= index)
  price?: number;         // defaults to the candle's low (side low) or high (side high)
};

detectDivergences(candles, oscillator: LinePoint[], pivots, {
  idPrefix,               // required, caller-owned: 'rsi' -> 'rsi.divergence.regular.bullish'
  label = '',             // leads event names; pass the label you register with eventDefinitionsFor. Not hashed
  minBars = 5,            // pivot spacing allowed, inclusive
  maxBars = 120,
  minOscillatorDelta = 0, // oscillator must differ by more than this
  source = {},            // caller's description of oscillator + pivots, e.g. { oscillator: 'rsi', length: 14, pivots: 'cycle' }
}) => IndicatorEvent<DivergencePayload>[]

eventDefinitionsFor(idPrefix, label) => IndicatorEventDefinition[]   // the four ids for a prefix
getEventDefinitions() => []                                           // zero-arg contract; no own prefix
```

The oscillator is the `LinePoint[]` every line in the package returns (`computeRsi(...).rsi`,
`computeDSS(...).dss`), so a caller passes it straight in; the module aligns it to `candles` by `t`.
A candle with no point has no oscillator value, and a pivot there is skipped.

`source` is opaque: it is folded into `paramsHash` and copied to the payload, so a stored row says
which oscillator settings and pivot source produced it (`LevelInput.meta` does the same).

Ids are `${idPrefix}.divergence.${kind}.${direction}`, the `LevelInteraction` pattern: each
oscillator owns its ids (so two oscillators diverging on one date are two rows, not a key clash),
and the payload carries `kind` and `direction` so "every bullish divergence" is one payload query
across prefixes. Prefixes are registered where the platform's definitions are
(`getIndicatorEventDefinitions()` in the private library).

### The rule

Each pivot B is compared with the **previous pivot on the same side**, A (by `index`), when
`minBars <= B.index - A.index <= maxBars` and the oscillator is finite at both pivot bars:

| side | price | oscillator | event |
|---|---|---|---|
| low | B < A (lower low) | B > A + delta (higher low) | `regular.bullish` |
| low | B > A (higher low) | B < A − delta (lower low) | `hidden.bullish` |
| high | B > A (higher high) | B < A − delta (lower high) | `regular.bearish` |
| high | B < A (lower high) | B > A + delta (higher high) | `hidden.bearish` |

Equal prices give nothing. The oscillator is read **at the pivot bar**: a trailing indicator's value
there uses no later candle, so reading it adds no lookahead.

### Timing (no lookahead)

The event is stamped at `B.knowableIndex` (A is earlier and already knowable), and skipped when
that bar is not in `candles`. A walk-forward test pins it: detecting on every prefix
`candles[0..k]` (pivots filtered to `knowableIndex <= k`) reproduces exactly the full-run events
with `index <= k`.

Payload: `kind`, `direction`, `side`, `pivotIndex`, `pivotTime`, `pivotPrice`, `oscillatorValue`,
`previousPivotIndex`, `previousPivotTime`, `previousPivotPrice`, `previousOscillatorValue`,
`barsBetween`, `source`, `paramsHash`.

### Pivots

The module finds no pivots. A caller without its own can pass `Swing.computeSwings` highs and lows,
with `knowableIndex = index + lookback` (the bar swing events are stamped at). A second pivot
detector here would disagree with `Swing` on the same chart.

## Platform use (DWLF; not part of this package)

- **Pivots:** published, unrevoked `cycle.{low,high}.confirmed` rows (daily), knowable at their
  `confirmTime`; the read key levels and cycle fib already use (`toKeyLevelPivots`). Each event's
  `source` is `{ oscillator, length or settings, pivots: 'cycle' }`.
- The executor's legacy `rsi_14` and `cancel_bearish_divergence` (a 10-bar heuristic) are left as
  they are; converging them is a follow-up once these events have a track record.
- **Oscillators:** RSI(14) and the platform DSS. Prefixes `rsi` and `dss`, so
  `rsi.divergence.regular.bullish` and `dss.divergence.regular.bullish`.
- **Attention first** (the `Indicator events` epic guard): stored events, chart markers, briefing.
  No strategy-builder nodes until a divergence earns it out of sample.
- A ledger pivot can later be revoked. Live events already stored stay; a backfill replays today's
  pivot set (the platform convention, as key levels do).
