# ADR 0006: Behavioral overlay and calibration eligibility

- Status: accepted
- Date: 2026-07-28
- Phase: 6

## Context

Hard inference already defines the complete logically possible support after a
public history. Voluntary opponent choices can make some of those worlds and
some opponent-policy hypotheses more plausible, but soft behavioral evidence
must never add an impossible world, remove the last possible world, override a
known card or chronological void, or read simulator truth.

Behavioral sophistication is not itself evidence that production decisions
improve. The preregistered protocol therefore requires paired, prequential
comparison with the same hard-support occurrences and clean qualification
evidence before behavior may affect the shipped solver.

## Decision

### Overlay on hard support

Behavioral inference starts with every ordered occurrence in a `HardBelief`,
including duplicate sampled occurrences. It replays the public history through
an exact-hand hypothesis constructed only from that occurrence and canonical
events. The overlay changes normalized weights; it does not alter membership in
the hard support.

Each occurrence carries separate conditional model distributions for Player 2
and Player 3. Marginal world weights and each acting player's conditional model
posterior update jointly, while the non-acting player's conditional model
vector is unchanged by that decision. The model family contains the frozen
random and inspectable baseline archetypes. Composite `noisy-mixture` and
time-varying `phase-switch` policies are held out as stress cases.

### Alternative-aware likelihood

At every observed opponent decision, the engine reconstructs the actor-safe
observation and enumerates the complete legal card and take-hand alternatives
inside each hard-support occurrence.

- A forced singleton action has likelihood one for every model and contributes
  no behavioral evidence.
- A discretionary archetype assigns a preferred-action component plus a
  uniform legal-action lapse floor.
- The random model is uniform over all legal alternatives.
- A legal action always has positive soft likelihood; a rule-illegal action is
  rejected by exact replay rather than softened.
- Likelihood power is tempered analytically so the largest per-decision model
  Bayes factor is at most four, independent of the legal-set size.

Predictions are made before the observed action is applied. Action keys name
only real legal actions; a forced distribution therefore has one label rather
than an artificial impossible class.

### Truth and calibration boundary

Production inference accepts only a public `GameTimeline` and a matching
`HardBelief`. It has no simulator import or truth parameter. Synthetic truth is
written to a separate eval-only sidecar and may be joined to truth-free paired
prediction records only by the calibration scorer.

The hard-only and behavioral arms use the same ordered world occurrences,
checkpoint, query target, and seed. The harness scores owner, void, suit-length,
overtake, joint, conditional, and full-alternative action predictions. It uses
multiclass Brier score, log loss with epsilon `1e-12` plus raw zero-support
counts, deterministic tie-aware top-one scores, 50/80/95 credible-set coverage,
fixed reliability bins, nested trajectory aggregation, and paired whole-cluster
bootstrap intervals.

Phase 6 development, train, and tune runs are infrastructure/model-development
evidence only. They cannot enable production behavior. Qualification and final
splits require a separately frozen Phase 8 manifest.

### Production eligibility

Behavioral weighting remains disabled in the production solver until a frozen
qualification comparison:

1. passes every correctness, truth-firewall, reproducibility, latency, and
   terminal noninferiority gate;
2. improves a preregistered calibration, hidden-state, action-prediction,
   robustness, downstream-decision, or terminal metric; and
3. shows no preregistered catastrophic style regression.

If that evidence is absent, inconclusive, harmful, or over budget, the shipped
configuration remains the hard-only reference. Model posteriors may still be
shown as explicitly experimental diagnostics only when they cannot influence
the recommendation.

## Consequences

- Hard facts and correlated support remain authoritative.
- Player 2 and Player 3 can learn different uncertainty-aware model mixtures.
- Forced moves cannot masquerade as behavioral tells, and one discretionary
  move cannot produce an unbounded posterior jump.
- Calibration predictions remain truth-free and forced action supports remain
  semantically exact.
- Phase 6 can validate the inference and evidence machinery without making a
  premature production-improvement claim.
- Phase 8 must provide the clean eligibility and terminal-noninferiority
  evidence before behavioral weights may enter the selected production solver.
