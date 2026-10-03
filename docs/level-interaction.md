# Level interaction: one set of level events for every level-type indicator

Status: design (DWLF-332). Module: `LevelInteraction` (`src/indicators/level-interaction/`).

## Why

Support/resistance, key levels, Fibonacci levels, trendlines, VWAP and zones (order blocks, FVGs,
supply/demand) all need the same questions answered about price and a level: did price approach
it, test it, hold, break it, come back to it, flip it, or fail to break it. Today each indicator
answers some of them with its own tolerances (fixed percentages, close-only checks, a simple-mean
ATR), and some answer none. `SupportResistanceTracker` (this repo) and `srLifecycle` (private
FSM) are two diverged attempts at the same machine.

This module answers them once. A caller supplies **levels** (a geometry, a role, and the bar the
level became knowable); the module walks the candles and returns events.

## Inputs

```ts
type LevelGeometry =
  | { kind: 'horizontal'; price: number }
  | { kind: 'sloped'; anchorIndex: number; anchorPrice: number; slopePerBar: number }
  | { kind: 'zone'; upper: number; lower: number };

type LevelInput = {
  id: string;                         // stable, caller-owned; carried on every event
  geometry: LevelGeometry;
  role: 'support' | 'resistance';     // role at formation
  knowableIndex: number;              // first bar at which the caller could know the level
  endIndex?: number;                  // optional: the level stops existing after this bar
  meta?: Record<string, unknown>;     // passed through on payloads, never interpreted
};

trackLevelInteractions(candles, levels, { idPrefix, ...params })
  => { events: IndicatorEvent<LevelEventPayload>[]; states: LevelState[] }
eventDefinitionsFor(idPrefix, label) => IndicatorEventDefinition[]
getEventDefinitions() => []   // the zero-argument contract every module keeps; this one has no prefix of its own
keepNearestApproaches(events) => events   // optional consumer-side filter
LEVEL_EVENT_KINDS                          // the fixed, published list of kinds
```

Event ids are `${idPrefix}.${kind}` (e.g. `keyLevel.broken`, `fib.level.rejected`), so each
consumer owns its namespace while sharing one behaviour. `kind` comes from the fixed,
published `LEVEL_EVENT_KINDS`; the prefix is the only free part. Every payload also carries
`kind` and `direction`, so "every bullish level break" is one query on the payload, whatever
the prefix:
- `bullish`: a resistance broken or reclaimed upward, a support that rejected or flipped to support.
- `bearish`: the mirror cases.
- `neutral`: formed, approached, tested, retested, expired.

**Prefix registry:** a consumer's prefix is registered where its definitions are, which is
`getIndicatorEventDefinitions()` in `@andywilliams/indicators`. That registry already feeds every
platform allow-list. Two consumers must never share a prefix.

`states` is each level's state after the last bar (role, confirmed, phase, touches, expired),
so a caller that needs the current picture does not have to fold the event stream itself.

## The band

Every check is against a **band** around the level at bar `i`, scaled by Wilder ATR(`atrLength`)
at that bar (from `math/atr`):

- `horizontal`: `price ± touchAtr·ATR`
- `sloped`: `anchorPrice + slopePerBar·(i − anchorIndex) ± touchAtr·ATR`
- `zone`: `[lower, upper]` as given (no widening)

Before ATR exists (warm-up) no interaction is judged; only `formed` and `expired` can fire.

## Events and the state machine

Each level carries a **role** (support or resistance), whether that role is **confirmed**, and a
**phase** (`away` or `touching`). For a support role, "beyond" means a close below
`bandLower − breakAtr·ATR`; "touching" means the bar's low reaches the band and the bar is not
beyond; "away" means the close is above the band. Resistance mirrors it.

Per bar, in this order:

| event | when | then |
|---|---|---|
| `formed` | `i == knowableIndex` | role confirmed, phase away |
| `broken` | close is beyond, and not a reclaim | role ← opposite, **unconfirmed**; remember the break bar |
| `reclaimed` | close is beyond within `reclaimBars` of the last break (a failed break), even if a quick retest already flipped the role | role ← opposite (the original), confirmed |
| `tested` | phase away → touching, role confirmed | count the touch |
| `retested` | phase away → touching, role unconfirmed (first return after a break) | |
| `rejected` | phase touching → away, role confirmed (the level held) | |
| `flipped` | phase touching → away, role unconfirmed (the old level held from the other side) | role confirmed |
| `approached` | phase away, close within `approachAtr·ATR` of the band's near edge, no approach episode open | open an approach episode |
| `expired` | at the close of the `expiryBars`-th bar without a touch or break, or of `endIndex` | stop tracking |

A break that is not reclaimed within `reclaimBars` and later comes back through is an ordinary
`broken` of the provisional role.

## Episode de-dupe rules

- **approached** fires once per approach episode. The episode closes when the close moves more
  than `approachResetAtr·ATR` from the band, or on any touch or break.
- **Levels are independent.** One level's events never depend on which other levels were passed
  in the same call. A consumer that wants only the nearest approached level per side and bar
  applies `keepNearestApproaches` to the events afterwards.
- **tested / retested** fire on the first bar of a touch episode (consecutive touching bars).
  The episode ends in exactly one of `rejected`, `flipped`, `broken` or `reclaimed`.
- **Re-arming after a hold.** After `rejected` or `flipped`, a new touch episode needs the close
  to move more than `touchResetAtr·ATR` away from the band first. Until then, touches are the
  same episode continuing (price hovering at the level) and fire nothing; a break still fires.
  The hold bar's own close counts: if it is already beyond `touchResetAtr`, the next touch is a
  new episode. The approach episode stays open until `approachResetAtr`, and also after a break,
  since price has just come through the level. Without this rule, a market
  that wicks into a level bar after bar fires tested + rejected on every bar (BTC under 79.6k,
  21 Aug to 1 Sep 2026: 8 pairs in 12 days).
- **formed** and **expired** fire once per level.

## Knowability (DWLF-330)

- Every event is stamped at the bar whose close makes it knowable: `index` is that bar. Nothing
  uses a later bar; ATR is causal. The caller is responsible for `knowableIndex` being honest.
- Payloads are the state at that bar: `{ levelId, kind, direction, role, confirmed,
  originalRole, price, upper, lower, close, atr, distanceAtr, touches, barsSinceFormed,
  paramsHash, meta }`. `paramsHash` (from `hashParams`) records which parameters produced the
  event, so stored events from different settings can be told apart.
- Walk-forward property, tested: for any `n`, the events from `candles.slice(0, n)` equal the
  events from the full series with `index < n`.

## Defaults

Tuned on real daily candles before this module is published (see the PR). A later change to a
default is a behaviour change for stored events: it ships as a `feat`, and `paramsHash` shows
which events predate it.

## Consumers and migration

1. Key levels (DWLF-333): the first consumer, end to end, under the `keyLevel` prefix.
2. Fibonacci levels (DWLF-334), trendlines V3 (DWLF-183), ranges (DWLF-60) and zones follow,
   each under its own prefix.
3. Retired once `keyLevel.*` is live and backfilled, each by its own ticket:
   - the platform's `price_near_sr` and `breakout` events (scheduled-jobs; fixed percentages,
     close-only), superseded by `keyLevel.approached` and `keyLevel.broken`;
   - `SupportResistanceTracker` and its `supportResistance.level.*` ids. Its one caller (the
     frontend's markets slice, client-side) switches to reading `keyLevel.*` events from the API;
   - `srLifecycle` (private, unused), deleted.

## Not in scope

Finding levels. This module never decides where a level is; it only reports how price
interacts with levels it is given.
