# ADR 0005: Hard-belief terminal root rollout baseline

- Status: accepted
- Date: 2026-07-27
- Phase: 5

## Context

The first production recommendation layer must evaluate every legal user action
against terminal Bhabhi risk without importing simulator truth. It must preserve
correlated hidden hands, each actor's legitimate information set, independent
self-interest for Player 2 and Player 3, rule chance, escape identity, and the
three-to-two-player transition.

This phase establishes a trustworthy imperfect-information baseline. It does
not yet claim behavioral calibration, equilibrium play, advanced tree search,
or exact endgame solving.

## Decision

### Production boundary

The only production entry is a complete `GameTimeline`. Search:

1. replays and hashes its active event prefix;
2. builds a hard belief from that same timeline;
3. rejects any world whose history hash is stale;
4. constructs a neutral exact-hand hypothesis only from
   `HiddenWorld.currentHands` plus the replayed public state.

`src/search/**` cannot import `src/simulator/**`. Shared keyed randomness,
policies, actor observations, and exact-hand transitions live in neutral
modules. An explicitly named test-only scenario entry accepts hand-built
52-card toy states; it warns when no complete event ledger is supplied.

### Root sampling and terminal utility

Every legal user card and legal root take-hand action is applied to every
materialized hidden-world occurrence. Duplicate direct samples remain separate
occurrences and therefore retain their sampled probability mass. Each
continuation runs to a rules-engine terminal state and records vector loss by
seat, not a card-count or pickup proxy.

Continuation policies are frozen baseline policies. Player 2 and Player 3 act
for themselves from separate actor observations; no anti-user minimax oracle is
used. The same continuation policy is used at a given user's information set
across determinizations, avoiding per-world re-optimization and strategy
fusion.

All candidate actions share worlds and semantic random tapes. Policy streams
are keyed by replicate, actor, and absolute actor-decision ordinal. Chance
streams additionally use sampled-world occurrence, absolute chance ordinal,
pending kind, player, and source. Candidate action is never a stream key.
Chance draws use the exact eligible waste or source hand.

### Actor knowledge

Policies receive a detached, frozen `PolicyObservation`, never raw public state
or exact world. Private player-draw identities and privately revealed
hand-transfer cards are visible only to involved actors. Public plays, thullas,
pickups, and visible waste draws remain common knowledge. Production
observations use the complete active event ledger.

### Diagnostics and uncertainty

The primary estimate is terminal user-Bhabhi probability. The payload also
retains:

- user finish class and Bhabhi identity by seat;
- root-trick pickup probability and count;
- power after the root trick and any required draw resolve;
- first opponent escape and the user's heads-up opponent;
- per-action sample and global outcome checksums.

Marginal intervals use one bounded observation per sampled-world cluster:
stochastic repeats within the same world are averaged first. Candidate-minus-
recommended differences use paired world-cluster bootstrap intervals. A fully
enumerated, deterministic, chance-free comparison has a point interval.
Comparisons against the data-selected minimum are labeled heuristic; all Phase
5 recommendation payloads remain `Approximate`.

Fixed work quotas determine payload bytes. Wall time is separate telemetry and
never truncates or changes a result. Any cancellation, illegal policy choice,
stale world, event cap, chance inconsistency, or invariant failure aborts the
whole recommendation; survivor-only rankings are forbidden.

### Initial live presets

The initial baseline presets are:

| Budget   | Worlds | Replicates/world | Worker deadline |
| -------- | -----: | ---------------: | --------------: |
| Instant  |      1 |                1 |          500 ms |
| Balanced |      4 |                1 |        2,500 ms |
| Deep     |     16 |                2 |            15 s |
| Offline  |     64 |                4 |            60 s |

These deliberately small Phase 5 live samples expose wide uncertainty. They are
latency-entry baselines, not evidence that one sampled world is statistically
adequate. Later phases may replace them only through the preregistered
correctness, calibration, terminal-performance, and latency gates.

## Consequences

- Every legal root action has a complete terminal value under the same
  correlated world occurrences and continuation assumptions.
- Deterministic and correlated traps can be tested without simulator imports or
  hidden-truth access.
- Rule chance, first escape, and heads-up identity remain causal parts of value.
- Small live budgets are responsive but intentionally coarse; the UI must show
  intervals, sample counts, method, and `Approximate`.
- Bundled continuation policies decline optional future take-hand choices.
  Enabled take variants evaluate every legal root take and surface this future-
  policy limitation explicitly.
- Phase 6 must add and calibrate uncertain opponent behavior. Phase 7 must
  compare stronger information-set search and exact/near-exact late solving
  against this frozen eligible baseline.
