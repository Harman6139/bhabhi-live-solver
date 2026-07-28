# ADR 0004: Actor-safe seeded simulator and immutable raw artifacts

- Status: accepted
- Date: 2026-07-27
- Phase: 4

## Context

The complete-game simulator serves three different purposes:

1. exercising exact rules and state invariants;
2. generating reproducible policy and solver experiments;
3. hiding synthetic truth from the same production inference/search path used
   by the live product.

A raw `PublicInformationState` is not a safe policy input. It is specifically
the human user's information state and contains the user's exact hand and
user-relative known-opponent ownership. Giving that object to Player 2 or
Player 3 would leak private information even though its type says "public."

One mutable random stream per game would also make results depend on incidental
consumption order. A policy refactor or one extra random draw could then alter
another player, a future chance event, and every paired comparison.

## Decision

### Actor information boundary

Every simulator actor receives a detached, recursively frozen
`PolicyObservation` containing:

- that actor's exact hand;
- its legal cards and legal take targets;
- the active rules, counts, trick, power, turn, active order, waste, and escape
  groups;
- publicly observed card plays, the immediately relevant pickup, and
  chronological public suit status.

The observation never contains another exact hand, `unresolvedCards`,
`knownOpponentCards`, a `HiddenWorld`, a belief, simulator truth, or future
chance values. Opponent private legal sets are stored only in the
`truth.eval-only.ndjson` sidecar.

Public suit knowledge is replayed chronologically. Pickups and visible draws can
restore a suit; transfers remove known ownership from the source; a known-has
status becomes unknown when its last publicly tracked card leaves. The actor's
own suit status is exact.

### Policy semantics

Phase 4 freezes version 1 of:

- uniform random legal;
- always high;
- always low;
- shortest suit, then low;
- high-card early shedder using monotonic prior-play count;
- power avoider;
- a labeled documented/basic heuristic;
- the preregistered noisy mixture;
- the preregistered three-player-to-heads-up phase switch.

All deterministic ties use canonical deck order. The documented/basic policy is
an operational hypothesis based on limited reported advice about remembering
voids and avoiding immediate reuse of a picked-up suit. It is not claimed to be
validated or strongest.

The API can express card play and optional take-hand selection. The seven
required baselines decline taking; canonical evaluation disables it. Genuine
waste/player draws remain environment chance events.

### Randomness

`splitmix64-counter-v1` is the frozen local simulation PRNG. String, integer,
and bigint seeds have distinct canonical encodings. Bounded selection uses
rejection sampling and shuffling uses Fisher-Yates.

Each semantic invocation starts from a keyed counter stream:

- deal;
- actor and actor decision ordinal;
- chance kind/player and chance ordinal.

Forking does not consume the parent. Random use by one actor cannot perturb
another actor or chance. The evaluation roots use the exact `eval-v1` SHA-256
formulas preregistered in `docs/evaluation-plan.md`.

### Raw artifacts

Development and later confirmatory runs use the immutable directory contract in
the evaluation plan. Files are UTF-8/LF, JSON or NDJSON, schema versioned, and
covered by SHA-256 checksums. Public game/decision records exclude opponent
private information; exact deals and private audit traces live only in the
eval-only truth sidecar.

A verifier checks:

- required files and SHA-256 digests;
- every record schema;
- public event replay and terminal hashes;
- eval-only concrete-truth replay and 52-card conservation;
- raw-record cardinalities;
- regenerated summary bytes;
- the zero-failure gate.

Run directories are staged and atomically renamed. Existing run IDs are never
overwritten.

## Consequences

- Simulator policies can be evaluated without accidental perfect information.
- Paired seeds remain stable under unrelated random consumption.
- Failures, caps, and invariant errors remain visible instead of silently
  disappearing from a denominator.
- Phase 4 smoke results validate infrastructure only. They are explicitly not
  qualification/final evidence and cannot support a "strongest" claim.
- Production search cannot import simulator modules; it must operate on
  legitimate beliefs and its own information-safe search state.
