# ADR 0007: Phase 8 confirmatory selection contract

- Status: accepted
- Date: 2026-07-28
- Phase: 8

## Context

The valid Phase 7 development primary and independent reproduction runs found
the same terminal result for the frozen hard-only reference and the optional
exact-then-fallback candidate: 35 user-Bhabhi games in 204 games per
configuration, a paired macro delta of zero, and a crossed cluster-bootstrap
interval of `[0, 0]`. Exact search was selected 52 times and otherwise retained
typed refusals. It was slightly slower and did not establish a terminal,
calibration, or simplicity advantage.

Phase 6 development calibration showed that behavioral weighting can change
proper scores, but that evidence is not qualification evidence. It also exposed
finite-sample raw-zero predictions and a Player 3 forced-action regression.
Behavior therefore remains disabled until a clean, frozen Phase 8 comparison
satisfies every eligibility gate.

This ADR fixes the remaining confirmatory choices before any qualification seed
is generated: the candidate roles, primary behavioral endpoint, multiplicity
method, component eligibility rules, selection order, and the case where the
reference itself is selected.

## Decision

### Current production reference

The frozen reference is
`phase5-balanced-hard-only-reference-v1`:

- canonical rules;
- direct Phase 5 terminal root rollout;
- hard correlated belief;
- behavioral weighting off;
- exact endgame off;
- the frozen Balanced work quota and deterministic documented-basic
  continuation policy.

It remains the production default unless and until a valid Phase 8 selection
attestation chooses another eligible configuration. The Phase 7 exact result is
a practical tie, not an improvement claim.

### Frozen qualification candidate roles

The qualification manifest may bind at most these four full configuration
roles. Concrete source, configuration, fitted-model, scorer, and report hashes
are filled only after train/tune and the development sizing run are complete.

| Role | Stable role ID                     | Behavioral weighting                 | Exact endgame                                               |
| ---- | ---------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| R    | `p8-r-hard-balanced-v1`            | off                                  | off                                                         |
| E    | `p8-e-exact-hard-fallback-v1`      | off                                  | try exact, then the byte-identical R request                |
| B    | `p8-b-behavior-balanced-v1`        | fitted separate P2/P3 model mixtures | off                                                         |
| BE   | `p8-be-behavior-exact-fallback-v1` | fitted separate P2/P3 model mixtures | try behavior-aware exact, then the byte-identical B request |

No more than these four roles may be opened on qualification. A role whose
implementation, correctness, development sizing, or latency prerequisites fail
is marked ineligible before opening and omitted rather than silently replaced.
Omission does not authorize a new role. All roles use the same canonical
17-cell matrix, base deals, rotations, actor-policy seeds, environment chance,
and style-neutral solver streams.

E and BE are optional performance/search components. Exactness is not required
for rule correctness, so exact-on must show multiplicity-controlled terminal
improvement; exact agreement plus noninferiority alone cannot enable it.

### Train/tune boundary and displayed support

Behavior parameters and opponent-family priors are fit on `train`.
Temperatures, lapse/error mixture, Bayes-factor cap, hard-world count, and any
robust-choice option are chosen once on `tune`. Stress style cells 16 and 17 are
excluded from fitting and tuning and return unchanged in qualification and
final. Player 2 and Player 3 retain separate conditional model distributions.
The selected serialized model binds the train/tune artifacts, source, scorer,
family, and configuration hashes.

Support regularization uses a distinct development/tune authority bound to the
selected behavior-model bytes. Once its tune selection is sealed, the behavior
and support selections are combined into the production-model bytes. The
qualification authority is frozen only afterward and binds that production
model; the tune authority cannot open qualification.

The frozen train/tune grid is the Cartesian product of:

- lapse probability: `0.04`, `0.08`, `0.16`;
- likelihood power: `0.25`, `0.5`, `1`;
- maximum per-observation Bayes factor: `2`, `4`;
- public hard-world count: `4`, `16`, `64`; and
- robust-choice option: off/on.

This is 108 auditable candidates. Pooled prequential public-action negative log
loss selects the behavior candidate, with deterministic numeric parameter order
and robust-off preferred on an exact score tie. The separately scored
support-regularizer pseudocount grid is `0.25`, `0.5`, `1` per hard-feasible
label; equal-family unresolved-soft tune Brier selects it, with the smallest
pseudocount winning an exact tie.

Support-regularizer selection reuses the frozen tune namespace but has its own
truth-side scoring artifact. Its schedule is exactly 64 base deals × the 15
fittable style cells × three rotations: 2,880 complete games grouped into 960
style-base clusters. The three pseudocount candidates are scored on identical
checkpoints, hard worlds, behavior weights, and realized labels; simulation and
belief construction are shared across candidates. This tune-only schedule is
not confirmatory evidence and cannot access qualification or final opening
authorities.

Hard-known predictions remain exact and are never smoothed. For an unresolved
displayed categorical query, probability regularization may allocate positive
mass only to labels that are feasible under hard constraints. The regularizer
and its strength must be selected on tune and frozen in the serialized model.
Qualification/final truth cannot choose or alter it. Assigning raw zero
probability to a logically possible realized label is a release blocker and is
reported separately from epsilon-clipped log loss.

### Primary behavioral eligibility endpoint

The prespecified primary behavioral endpoint is the equal-family macro Brier
score over unresolved soft hidden-state query predictions:

- card owner;
- current void;
- suit length;
- can overtake;
- the canonical joint event; and
- eligible conditional queries.

Queries are averaged within state, states within game, and complete games within
the frozen cluster. Hard-known predictions and forced opponent actions are
reported separately and cannot dominate this endpoint. The comparison is
behavioral minus hard-only on the same checkpoints and hard-support
occurrences. A behavioral role satisfies its evidence-specific rule only when
the multiplicity-controlled one-sided 95% simultaneous upper bound for this
difference is strictly below zero.

Overall-soft Brier/log loss, family-level scores, discretionary action NLL and
top-one accuracy, forced-action scores, interval coverage, reliability, and
displayed terminal-risk Brier/log loss are secondary diagnostics. They can
disqualify a candidate for a correctness, robustness, support, or calibration
failure but cannot substitute for the frozen primary endpoint.

### Confirmatory statistics and integrity

Qualification and comparative final terminal results use a crossed paired
cluster bootstrap over `baseIndex`. One resampled base retains all 17 cells,
three rotations, and every frozen configuration. Exactly 20,000 deterministic
bootstrap resamples are used.

One common bootstrap draw produces all frozen candidate-versus-reference
contrasts. Simultaneous max-statistic bounds, recorded in the manifest, control
multiplicity instead of Holm adjustment:

- terminal noninferiority requires the simultaneous one-sided 95% upper bound
  for `candidate - R` to be strictly below `+0.005`;
- optional performance/search improvement requires its simultaneous one-sided
  95% upper bound to be strictly below zero;
- a final `beats` claim additionally requires the untouched-final two-sided 95%
  interval to lie wholly below zero;
- a practical tie requires an absolute point delta at most `0.0025` and a
  two-sided interval spanning zero.

A cell is a catastrophic regression when its point delta is at least `+0.05`
and its one-sided 95% lower bound is strictly above `+0.02`. Either condition
alone is descriptive; both together disqualify the role.

The terminal base count is calculated before opening each split from the
largest relevant paired-cluster standard deviation:

```text
N = clamp(64, 512, roundUpTo16(1.10 * (1.96 * s / 0.01)^2))
```

Qualification uses only development variance. Final uses qualification
variance and never the observed effect sign. The existing CPU-hour caps and
complete-block stopping rule remain unchanged.

Every evidence run must have a complete config-by-cell-by-base-by-rotation
matrix, zero simulation/invariant/event-cap/cancellation/stale-publication
failures, replay-valid raw games and eval-only truth sidecars, deterministic
summary regeneration, verified checksums, and unchanged bound source. No
failure or partial exact result may be silently excluded.

### Component eligibility and selection

Every role must first pass correctness, conservation, replay, truth-firewall,
fixed-seed reproducibility, complete-matrix, catastrophic-style, terminal
noninferiority, live latency, cancellation, stale-publication, and memory
gates.

Additional role rules are:

- E requires multiplicity-controlled terminal improvement over R.
- B requires the frozen primary behavioral Brier improvement, exact
  preservation of every hard-known prediction, zero raw-zero feasible truth
  outcomes, and separate/noise-robust P2/P3 posteriors.
- BE must independently satisfy both the behavioral rule and the optional-exact
  terminal-improvement rule. It cannot inherit eligibility from E or B.

Among eligible roles, select the lowest qualification equal-cell macro user
Bhabhi estimate. Apply the practical-tie rule first; ties are then broken by
calibration and robustness, lower Balanced p95 latency, and finally fewer
enabled components. The write-once selection attestation records every
eligible/ineligible reason and the ordered fallback list. The reference is
always the last safe fallback.

### Reference-selected final

If R wins qualification, the final manifest records
`selectionIsReference=true`. Final then runs one fresh-seed R arm over the full
17-cell matrix to confirm raw integrity, terminal reporting, calibration,
latency, truth-firewall, and robustness behavior. It must not duplicate R under
a candidate label, construct an artificial zero contrast, or make a
comparative `beats` claim.

The corresponding final calibration mode is also one-arm: it reports the hard
reference's hidden-state, action, support, hard-known, reliability, and
terminal-risk diagnostics, while marking the behavioral contrast not
applicable. It may not synthesize a behavioral arm or a zero behavioral
contrast.

If a non-reference role wins, final compares only that selected role with R on
fresh final seeds. Failure of final terminal noninferiority or any release gate
selects the first preregistered eligible fallback and is reported honestly.
There is no tuning, recalibration, candidate substitution, or threshold change
after final is opened.

### Split-opening firewall

Qualification seeds may be derived only from a write-once manifest that binds:

- a clean committed source snapshot and diff status;
- this ADR and the evaluation-plan hash;
- canonical rules and all 17 style cells;
- included candidate roles and ordered fallback;
- selected model and every configuration hash;
- sample size and compute cap;
- seed/PRNG policy;
- scorer, bootstrap, summarizer, verifier, and report hashes;
- environment and browser benchmark policy; and
- required artifact schemas and commands.

Final seed derivation remains unavailable until qualification artifacts verify,
the selection attestation is immutable, the production configuration and
fallback order are committed, the final sample size is frozen, and a separate
write-once final manifest binds the unchanged report code.

Seed material is never logged, previewed, or generated before its manifest
authorizes that split. Development pilots cannot enter qualification/final
denominators, summaries, bootstrap samples, calibration records, or selection.

Environment chance uses the style-dependent `chance` stream. Solver chance uses
a distinct `solver-chance` stream whose seed material contains only base index,
rotation, and replicate, like the other style-neutral solver streams. Neither
stream may be substituted for or derived from the other.

### Latency and ablation obligations

Eligibility is measured from the production browser build and the same worker
bundle/configuration intended to ship:

- deterministic entry feedback p95 at most 100 ms, with p99 reported;
- zero analysis-caused main-thread tasks over 50 ms;
- Instant valid-result p95 at most 750 ms;
- Balanced valid-result p95 at most 3 seconds;
- Deep valid-result p95 at most 20 seconds;
- at least 1,000 warm representative requests per live mode;
- at least 100 cold starts per live mode;
- zero obsolete publications in at least 1,000 rapid edit/cancel races; and
- CPU time and worker/process peak memory reported from the recorded machine.

A candidate-independent corpus is frozen before solver results are read.
Required implemented components are ablated on that corpus. Architectures not
implemented or not eligible, including particles/resampling/rejuvenation when
absent, are explicitly reported as not implemented rather than assigned
invented results.

## Consequences

- The simplest valid measured configuration wins; optional exact or behavior
  code is disabled when its clean evidence is absent, inconclusive, harmful, or
  over budget.
- Behavioral inference has one declared confirmatory endpoint instead of a
  post-hoc choice among development metrics.
- Simultaneous intervals preserve pairing and control the frozen four-role
  family with one deterministic bootstrap.
- Reference selection still receives fresh final confirmation without a
  misleading self-comparison.
- No qualification or final seed can exist before its complete immutable
  authority is frozen and verified.
