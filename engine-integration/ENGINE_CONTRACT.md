# Gin Lab ↔ gin-rummy-engine rule contract

This folder is the compatibility boundary before the browser game delegates authority to Rust.

## Authoritative state

The Rust service will own the complete deal: both ten-card hands, ordered stock, initial upcard, dealer, scores, and the rule profile. The browser receives only its legal view plus public events.

## Required event record

Every action is append-only and numbered. An event contains `sequence`, `hand`, `turn`, `seat`, `phase`, `action`, `draw_source`, `card` when public, `upcard`, `discard_top_before`, `discard_top_after`, and score/dealer changes when a hand settles.

This records every discard in order. At review time it reconstructs the public position at every decision, while the completed-hand record can reveal both hands for study.

## Compatibility decisions

| Gin Lab rule | Engine responsibility |
| --- | --- |
| First dealer is random | Host chooses the initial dealer before constructing a round. |
| Winner deals next | `Table` defaults to `DealerRotation::WinnerDeals`; the server will keep that setting. |
| First offer goes to the non-dealer | Round driver behavior. |
| Both players pass the upcard | Engine keeps the initial upcard in the discard pile and forces the non-dealer's next draw from stock. No Gin Lab rule adapter is required. |
| Drawn discard cannot be shed immediately | Enforced from the engine view's taken-discard card. |
| Knock, gin, undercut | Engine rules profile, verified against `rules.json`. |

## AI policy

The production opponent will be `MonteCarloBot`. The initial target is 128 samples per decision. The service will call `assess` at user decision points and store candidate assessments for review, while using the selected action for the AI seat.

## Phase-one acceptance checks

1. The dependency versions resolve and compile on the host.
2. A fixed deal validates the 10/10/31-card invariant.
3. The driver gives the upcard first to the non-dealer.
4. A double initial pass forces stock, never allows the initial upcard as that forced draw, and preserves the public discard history.
5. A discard taken from the pile cannot be immediately shed.
6. A settled hand assigns the next dealer to its winner; a dead hand retains the dealer.

