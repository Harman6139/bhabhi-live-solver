# ADR 0003: Compile Hard Evidence Over Initial-Deal Witnesses

- Status: Accepted
- Date: 2026-07-27
- Scope: Phase 3 hard inference and correlated hidden-world construction

## Context

The live solver observes public events, exact user cards, exact pickups and
transfers, hand counts, and chronological follow-suit facts. It never observes
the ordinary hidden contents of Player 2 or Player 3.

A tempting implementation is to allocate only the cards in the final
`unresolvedCards` pool while maintaining a current `seat × suit` forbidden
matrix. That representation fails under temporal ownership. For example,
Player 2 can prove Hearts-void, then take Player 3's unrevealed hand and thereby
acquire hidden Hearts. Clearing Player 2's old void admits initial deals that
were already impossible; retaining it against the merged current hand rejects
legal deals.

There are only two hidden starting hands. Under the current closed event and
rule schemas, every exact observation and rule constraint can be compiled into:

1. a per-card set of allowed initial owners (`p2`, `p3`, or both);
2. a chronological location projection for each surviving origin; and
3. one exact starting-cardinality constraint for Player 2, with Player 3 as the
   complement.

## Decision

Hard inference treats the initial opponent deal as the latent witness.

For every card outside the user's initial hand, the compiler symbolically
replays two origin branches, one starting at Player 2 and one at Player 3. It
eliminates a branch when it contradicts:

- the declared A♠ holder;
- an observed play or draw source;
- compulsory follow-suit at the moment of an off-suit play;
- the `highest` opening-off-suit profile;
- an exact revealed hand;
- exact public ownership or card-location invariants.

Public plays, pickups, draws, waste movement, and revealed transfers update the
branch location. An unrevealed opponent-to-opponent take moves every branch
currently at the target to the actor, preserving its initial origin.

If `F2` cards are forced initially to Player 2, `F3` to Player 3, `B` remain
flexible, and Player 2 started with `s2` cards, exact support is:

```text
C(|B|, s2 - |F2|)
```

Capacity contradictions or a zero-owner card produce a typed zero-support
error. Counts and ranks use `bigint`.

Each `HiddenWorld` retains:

- the initial Player 2 / Player 3 witness allocation;
- the projected current exact hands;
- the active public-history hash; and
- a deterministic witness identifier.

Different initial witnesses remain separate even if a hidden hand merge makes
their current hands identical. This provenance is required for later behavioral
likelihoods.

Small supports are enumerated in lexicographic combination order. Large
supports use direct uniform rank sampling with deterministic, index-addressable
64-bit rejection sampling; no proposal rejection, repair, or `Math.random` is
used. The initial live thresholds are engineering defaults, not performance
claims, and remain subject to later latency evaluation.

Logical suit status is computed from the complete hard support:

- `known-void`: no feasible witness gives the seat a current card of the suit;
- `known-has`: no feasible witness leaves the seat without the suit;
- `unknown`: both are feasible.

It is never inferred from sample absence.

## Alternatives considered

### Final unresolved-card allocation plus permanent void flags

Rejected because it cannot represent timed void evidence across acquisitions
and hidden hand merges.

### Clear a suit void whenever that suit is acquired

Rejected because an exact pickup restores only the acquired cards. Other hidden
cards of that suit remain excluded by the earlier observation.

### Rejection-sample shuffled deals

Rejected as unnecessary and potentially wasteful. With two opponents and unary
origin masks, direct combinatorial assignment is exact and rejection-free.

### Independent ownership marginals

Rejected as the internal representation because fixed hand sizes and
chronological constraints create strategically important correlations.

## Consequences

- Correction, undo, and branching rebuild all evidence from active history;
  redo and orphan tails cannot influence belief.
- Exact support can exceed 32-bit range, but remains cheap to count.
- Hidden transfers are handled without weakening prior facts.
- Joint and conditional ownership queries can be answered by restricted exact
  support counts or by reducing correlated worlds.
- Future event types that introduce non-unary hidden constraints must extend the
  compiler explicitly; they may not be silently approximated as unary masks.
- Production inference and its transitive consumers are statically forbidden
  from importing simulator truth, with a separate metamorphic leakage test.

## Validation evidence

- Exhaustive small combinatorics and rank/unrank tests.
- Initial support checks at `C(34,17) = 2,333,606,220` and
  `C(35,18) = 4,537,567,650`.
- Chronological opening/normal void, opening-highest, exact pickup, departure,
  hidden merge, revealed transfer, impossible-history, correction, redo/orphan,
  and suit-status tests.
- Exact query agreement with all 56 worlds in a tractable real-game prefix.
- Concrete deal survival across every prefix of the deterministic 61-event game.
- Fixed-seed generated legal-history property tests.
- Static transitive import firewall and three-truth byte-identical belief
  metamorphism.
