# Phase-one compatibility result

Checked against locally downloaded `gin-rummy 0.1.3` and `gin-rummy-engine 0.3.0` source.

## Confirmed direct matches

| Required Gin Lab behavior | Engine result |
| --- | --- |
| Initial dealer chosen by the host | `Round::from_deal` accepts an explicit dealer. |
| Non-dealer receives the first upcard offer | `Round::from_deal` starts the turn at `dealer.opponent()`. |
| Non-dealer PASS → dealer may take or PASS | `Round::pass` transfers the offer to the dealer after the first pass. |
| Both PASS | `Round::pass` sets `forced_stock` and returns play to the non-dealer. The upcard remains in the discard pile. |
| Forced turn cannot take the discard | `Round::take_discard` returns `MustDrawFromStock` while forced stock is set. |
| Taken discard cannot be re-shed | The engine tracks `taken_discard` in both `Round` and player `View`. |
| Winner becomes next dealer | `Table::new` defaults to `DealerRotation::WinnerDeals`. |
| Dead hand retains dealer | The round/game source documents a same-dealer redeal. |

## Result

The current Gin Lab rules now match the engine's native round flow. No rule fork is needed for the opening-upcard sequence, dealer ownership, or the no-immediate-reshed rule.

## Build note

Rust 1.99 and the exact crates have been installed/downloaded. Native Windows compilation needs the Microsoft C++ linker (`link.exe`), which is not present on this computer. This is a build-environment dependency, not an API or rule mismatch. The server implementation phase will add the C++ Build Tools before compiling the Rust service.

