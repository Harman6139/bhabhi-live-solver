# ADR 0002: Operational variant and correction semantics

- Status: Accepted
- Date: 2026-07-27
- Scope: exact meanings required to implement and test typed household variants

## Context

The sources establish that these variants exist but do not supply one universal
operational definition. “All variants tested” is meaningless until timing,
targets, precedence, chance, and correction failure behavior are deterministic.

## Decision

### Take-hand action

- A take is legal only at a fresh normal trick before its leader has played.
- The actor must be the current power holder and current turn.
- `disabled`: no take event is legal.
- `adjacent`: target is the raw adjacent seat in play direction; it is illegal if
  that seat has escaped.
- `next-active`: target is the next active seat in play direction, skipping
  escaped seats.
- `configured`: target must be an active non-actor seat listed in the serialized
  `configuredTargets` array.
- The actor receives the target's entire hand/count. Exact known ownership moves
  with those cards; if only one opponent remains, complement knowledge may make
  every unresolved card exact.
- The target escapes. Power remains with the actor, who leads the unchanged fresh
  trick.
- If the actor becomes the sole active player, the actor is Bhabhi.
- There is no hidden consent, payment, or arbitrary callback. Any future custom
  behavior requires another closed schema and ADR.

### Zero cards while retaining power

This rule is evaluated only after trick disposition and after determining
whether a pickup restored cards.

- `immediate-escape`: the zero-card power holder escapes; the next active seat in
  play direction receives power and begins a fresh trick.
- `waste-draw`: create a pending explicit chance event. The just-completed clean
  trick sits in an excluded holding area and is not eligible. The recorded draw
  must name a card from the prior waste; after the draw, the excluded trick joins
  waste and the drawn card is the forced next lead.
- `draw-from-player`: exactly one explicit recorded card is transferred from the
  selected source. `next-active` skips escaped players. `configured` treats its
  target as preferred; if that target is the drawing player or is no longer
  active, it deterministically falls back to `next-active`. The source can escape
  if the transfer empties its hand. The drawn card is the forced next lead. The
  just-completed trick is excluded until the draw completes.
- The reducer never chooses a random card internally. Replay consumes an explicit
  chance outcome and is deterministic.

### Heads-up precedence

- `normal`: use the ordinary trick and selected zero-power semantics.
- `pagat-shootout`: when a two-player leader plays their last card, the documented
  shootout outcomes take precedence over the general zero-power profile:
  - higher same-suit response lets the empty leader escape and leaves the
    responder Bhabhi;
  - lower same-suit response from a responder who still has cards creates the
    excluded-waste draw loop for the empty leader;
  - lower same-suit response that also empties the responder makes the leader
    Bhabhi;
  - an off-suit response makes the empty leader Bhabhi under the documented
    shortcut;
  - equal rank cannot occur with one standard deck.
- `simplified-thulla-wins`: with two active players, an off-suit responder escapes
  immediately and the leader is Bhabhi. Other clean-trick outcomes use normal
  semantics.
- A pending shootout/chance transition prevents premature terminal declaration.

### Highest opening off-suit

Under `highest`, a player with no Spades must play an off-suit card whose rank is
maximal in that player's exact hand. Equal-rank cards in different suits are all
legal; there is no suit tie-break. Public input for a not-fully-known opponent is
recorded unless it contradicts exact known ownership.

### Correction and stale suffixes

Two correction operations are exposed:

- atomic correction: replace one event and replay the whole retained suffix;
  reject without mutation at the first invalid event;
- rebase correction (UI default): commit the corrected valid prefix, stop before
  the first now-invalid retained event, and preserve that event plus the
  remaining suffix as explicit `orphanedEvents` for review/re-entry.

No derived state from the old suffix survives. Restoring the original event and
suffix must restore the original semantic hash.

## Consequences

- Rule configuration stays closed, serializable, runtime-validatable, and
  reproducible.
- Rare chance actions require an extra explicit record in the live tracker.
- Public validation remains honest about unknown opponent hands.
- Pagat shootout logic is a dedicated state-machine branch instead of scattered
  zero-card conditions.
- Corrections never silently discard history and never retain stale evidence.

## Verification

Table-driven tests cover every branch above, plus direction reflection, seat
escape, simultaneous last cards, ineligible draw cards, take target modes, equal
opening ranks, atomic error immutability, and orphaned-suffix restoration.
