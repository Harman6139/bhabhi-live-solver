# Project Progress

Last updated: 2026-07-28 (America/New_York)

## Completion contract

The persisted Goal is active and covers the full `GOAL.md` outcome, invariants,
phase gates, and release criteria. The goal must not be marked complete until all
Phase 9 and final release gates pass, or a true blocker is documented with
evidence and the smallest required user decision.

## Runtime verification

Verified from the current Codex turn context and loaded project configuration:

- model: `gpt-5.6-sol`
- reasoning effort: `ultra`
- Goal status: active
- multi-agent: proactive v2
- approval policy: `never`
- sandbox: `danger-full-access`
- project configuration: `.codex/config.toml`

The project-scoped configuration enables Goal and multi-agent features and sets
the requested approval and sandbox policies. Model and reasoning effort were
verified from the persisted session turn context because they are runtime
properties rather than fields in this project's TOML.

## Active phase

Phase 8 — source-freeze checkpoint immediately before clean qualification.

### Repository assessment

- Git repository is initialized on `master`.
- Verified Phase 7 baseline commit:
  `dc230b0 chore: establish verified phase 7 baseline`.
- Phase 0 through Phase 7 implementation, tests, development artifacts, and
  documentation are tracked at that commit.
- The Phase 8/9 implementation candidate is integrated and awaiting its
  source-freeze commit. No clean qualification or final seed namespace has
  been generated or opened.

### Current Phase 8 infrastructure status

- Frozen configuration roles are R (hard-only reference), E (hard-only exact
  attempt with byte-identical R fallback), B (behavior-weighted approximate),
  and BE (behavior-weighted exact attempt with byte-identical B fallback).
- Separate qualification and final authorities, canonical serialization,
  write-once split opening, sample-size provenance, 20,000-resample max-stat
  inference, noninferiority/improvement/tie/catastrophe rules, selection,
  reference fallback, and checksummed attestations are implemented and covered
  by focused tests.
- Environment chance, solver chance, and bootstrap randomness use separate
  semantic streams. Solver-chance and bootstrap streams are style-neutral so
  common random numbers remain valid across paired configuration arms.
- ADR 0009 freezes the first release as reference-only before either clean split
  opens. Behavioral train/tune, support tuning, and behavior calibration are
  explicitly not applicable for this registry; Phase 6 remains descriptive
  development evidence.
- Qualification and final are genuine one-arm R confirmations with no
  self-contrast and no “beats” claim. The browser latency contract permits only
  the genuinely executable R worker route; advanced IDs cannot relabel its
  timings.
- Worker-parallel terminal execution, immutable terminal/statistical artifacts,
  browser latency/cancellation artifacts, composite selection/final bundles,
  selected-release verification, production worker publication, UI
  explanations/diagnostics, correction invalidation, accessibility smoke, and
  Phase 9 release attestation are implemented.
- ADR 0008 now freezes the composite qualification/final evidence bundle and
  external generated-release binding before clean data. Selection cannot be
  authorized by an opaque or partial artifact hash.
- Latest pre-freeze checkpoint: format, lint, typecheck, production build, and
  desktop/mobile E2E pass. The complete suite reached 553/555 before two legacy
  20-second artifact-test caps; the same file then passed 6/6 under the
  project-wide 60-second ceiling. The authoritative complete suite is rerun by
  the frozen source-validation command set before qualification opens.

### Development environment

- OS: Windows 11 Home Single Language, build 26200, 64-bit
- CPU: Intel Core i5-9300H, 4 cores / 8 logical processors
- Memory: 8,225,972 KiB visible physical memory
- GPU: NVIDIA GeForce GTX 1650 and Intel UHD Graphics 630
- Node.js: v22.13.0
- npm: 10.9.2
- Git: 2.47.1.windows.1

This hardware record is the initial latency-test environment. Benchmark artifacts
must capture fresh free-memory, power-mode, browser, and build metadata at run
time.

## Completed evidence

- Read `GOAL.md` completely.
- Read `.codex/config.toml` completely.
- Verified the persisted active Goal through Goal control.
- Verified model, effort, permissions, sandbox, and multi-agent runtime metadata.
- Read `START-HERE.md`.
- Inspected Git state and repository contents.
- Confirmed initial authoritative rule sources describe Ace-of-Spades opening,
  compulsory following, first off-suit termination after the opening trick,
  highest-lead-suit pickup, power, waste, and multiple zero-card/two-player
  variants. Citations and conflicts are integrated into
  `docs/bhabhi-research.md`.
- Completed and independently reviewed the Phase 0 rule/strategy/source
  synthesis and unresolved-rule ledger.
- Preregistered protocol `eval-v1`, including crossed paired deals, split/seed
  policy, opponent cells, terminal metric, cluster bootstrap, compute stopping,
  calibration, ablations, eligibility, artifact schema, and latency budgets.
- Recorded 48 candidate strategy motifs with explicit evidence status and
  reproducible test/experiment specifications.
- Accepted ADR 0001 for the local-first functional TypeScript architecture and
  truth-firewall boundary.
- Selected the staged research architecture: direct correlated initial-deal
  construction; fresh full-history importance weighting before conditional SMC;
  information-safe paired terminal rollouts; benchmark-gated history search;
  exact late/post-escape solving.
- Validated that all required Phase 0 documents exist, contain substantive
  content, and have no TODO/TBD/FIXME placeholders.
- Initialized the strict React 19 / TypeScript / Vite project with local-only
  dependencies and Node 22 compatibility.
- Implemented typed cards, seat traversal, a runtime-validated closed
  `RuleConfig`, public state, deterministic event schemas, immutable reducer,
  legal-action helper, replay timeline, undo/redo, atomic and rebased correction,
  semantic history hashing, and canonical archive import/export.
- Implemented canonical opening, clean tricks, first-thulla termination, exact
  lead-suit pickup, escape, zero-power rules, take-hand modes, direction,
  highest-opening mode, and Pagat/normal/simplified heads-up profiles.
- Added complete 52-card accounting across exact/known/unresolved hands, current
  trick, waste, and pending excluded-trick holding; concrete simulator truth has
  a separate invariant guard.
- Added active-history semantic hashes plus a whole-document archive hash covering
  the active cursor, redo tail, and explicit orphan history.
- Closed reducer audit defects for exact-known opponent ownership and the initial
  Pagat off-suit response.
- Passed the Phase 1 gate with 56 deterministic tests and two fixed-seed
  fast-check properties: 128 generated deal partitions and 64 generated legal
  histories of up to 30 events, checking conservation and replay after every
  prefix.
- Implemented a responsive manual tracker with guided exact-hand setup,
  keyboard aliases and card taps, all closed `RuleConfig` options, pending
  waste/player draws, take-hand entry, current trick and player state,
  always-visible exact user and known-opponent cards, terminal result, and
  accessible reset confirmation.
- Added versioned IndexedDB autosave/restore/clear and checked canonical archive
  import/export from both setup and tracker screens.
- Serialized autosaves and added a session epoch so a reset invalidates stale
  callbacks and queued writes; the reset view unmounts live controls while old
  writes drain and the local record is cleared.
- Added a deterministic 61-event complete game (59 plays plus one explicit
  waste draw after setup) that ends with the user as Bhabhi under the Pagat
  shootout profile. Every prefix passes replay and 52-card conservation.
- Verified a genuinely changed terminal correction, subsequent autosave,
  IndexedDB reload, export, clear, import, and preserved terminal result in a
  production-browser E2E flow.
- Verified exact opponent A♠ ownership at setup, user cards disappearing after
  play, and visible opponent pickup identities remaining exact.
- Passed the Phase 2 gate: formatting, lint, typecheck, 56 deterministic Phase 1
  tests, two fixed-seed property tests, 16 integration tests, production build,
  desktop complete-game E2E, and mobile tracker/correction/responsive E2E.
- Completed an independent Phase 2 audit with no remaining functional blockers.
- Accepted ADR 0003: hard inference compiles unary ownership constraints over
  the initial hidden opponent deal and projects each surviving witness forward.
  This preserves chronological void evidence through exact acquisitions and
  hidden whole-hand merges.
- Implemented exact `bigint` support counting, lexicographic combination
  rank/unrank, deterministic unbiased 64-bit direct rank sampling, exact-versus-
  sampled materialization limits, witness/current-hand diagnostics, and typed
  zero-support errors with event-indexed elimination evidence.
- Implemented correlated `HiddenWorld` construction with initial provenance,
  current exact hands, public-history hashes, deterministic witness IDs, and
  aggressive initial/current 52-card invariants.
- Implemented exact ownership, joint, conditional, suit-length, expected-length,
  and logical `known-has` / `known-void` / `unknown` queries from the correlated
  support. Logical status never depends on sample absence.
- Covered opening and normal chronological voids, opening-highest evidence,
  exact pickups and departure, waste draws, revealed user takes, opponent-to-
  opponent hidden merges, opponent takes of the exact user hand, impossible
  later plays, corrections, undo/redo/orphans, and pending holding areas.
- Verified the concrete deterministic deal survives every one of the 61 game
  prefixes and that 32 fixed-seed generated legal histories never eliminate
  their true deal; every generated world passes exact conservation.
- Added a transitive TypeScript-AST import firewall covering production
  inference/search/worker/UI/entry roots and a three-distinct-truth metamorphic
  test requiring byte-identical belief output for fixed public history, config,
  and seed.
- Passed the Phase 3 gate with 29 focused inference tests, one generated-history
  inference property, three truth-firewall tests, all prior gates, production
  build, and production-browser E2E.
- Completed two independent Phase 3 adversarial reviews with no blocker or
  reproducible counterexample.
- Accepted ADR 0004 for the actor-safe simulator boundary, semantic counter RNG,
  optional strategic take actions, baseline-policy freeze, and immutable raw
  artifacts.
- Implemented `splitmix64-counter-v1` with canonical typed seeds, rejection-
  sampled bounded integers, Fisher-Yates shuffling, random access, snapshot
  restoration, and non-consuming semantic substreams. No simulation path uses
  ambient randomness.
- Implemented detached, recursively frozen actor observations containing only
  the actor's exact hand plus common table facts. Opponent policies cannot see
  the user's exact hand, unresolved ownership, hidden worlds, belief state, or
  simulator truth.
- Implemented nine versioned policy agents: the seven required baselines plus
  preregistered noisy-mixture and phase-switch stress policies. Deterministic
  ties use canonical deck order; the documented/basic policy remains explicitly
  labeled an unvalidated operational hypothesis.
- Implemented complete seeded games with independently keyed deal, actor, and
  chance streams; explicit waste/player-draw chance; optional take-hand actions;
  exact escape identity; terminal Bhabhi utility; semantic event/state/truth/
  outcome hashes; event caps; and exact 52-card checks after every transition.
- Centralized legal take targets in the rules layer and covered every take mode
  in both directions. Chronological public suit knowledge now follows pickups,
  draws, transfers, plays, and pickup-recency expiry.
- Implemented all 17 frozen opponent-style cells, exact eval-v1 SHA-256 seed
  roots, crossed deal rotations, deterministic schedule expansion, strict Zod
  raw schemas, eval-only truth sidecars, SHA-256 checksums, source/Git/policy/
  protocol hashes, atomic no-overwrite publishing, derived summaries, and a
  verifier that replays both public state and hidden truth.
- Passed 94 simulator tests and 10 evaluation/batch/artifact tests, including
  policy legality and permutation invariance, actor-view metamorphism, RNG
  isolation, all requested variants, seed vectors, schedule cardinality,
  checksum tampering, immutable writes, and summary regeneration.
- Completed two independent Phase 4 development smoke runs of 1,428 games and
  91,143 decisions each. Both had zero invariant, illegal-action, event-cap, or
  terminal failures and produced the identical deterministic reproduction
  digest `fnv1a64:d1e185b91f492a16`.
- Fully verified both Phase 4 artifact directories: 13 checksummed files,
  1,428 public and hidden-truth replays, 91,143 decision records, regenerated
  summary bytes, and zero failures per run. The run-independent seed projection
  SHA-256 was identical:
  `e184598822711b0ea5aa5eb2c7dd2c159127042dc43bdcd37179988a619481e9`.
- Phase 4 smoke results are development infrastructure evidence only
  (`evidenceEligible=false`). They are not qualification/final evidence and do
  not justify a strongest-policy claim.
- Extracted truth-neutral keyed RNG, actor-observation, baseline-policy, and
  exact-hand-transition modules. Production inference/search has no simulator
  import and constructs concrete hypotheses only from hard-valid
  `HiddenWorld.currentHands` plus the canonical public history.
- Implemented `hard-belief-terminal-root-rollout`: every legal user card or
  take action is evaluated to terminal Bhabhi utility across the same ordered
  world occurrences, with semantic common random numbers, genuine chance
  nodes, actor-safe observations, separate self-interested Player 2/Player 3
  policies, escape identity, heads-up transition, pickup/power diagnostics,
  clustered Wilson intervals, paired cluster-bootstrap differences, and
  all-or-nothing failure handling.
- Preserved duplicate direct samples as probability mass, enforced stale-world
  hashes and cancellation polling, and fixed private player-draw observation so
  uninvolved actors cannot learn the transferred card before it becomes public.
- Added 62 focused solver tests and three actor-privacy tests covering the
  deterministic/correlated Diamond trap, dynamic-rank reversals, singleton void,
  escape identity, noncolluding utility, both chance variants, take actions,
  strategy-fusion prevention, actual two-action CRN traces, caps, cancellation,
  stale history, clustered uncertainty, and configuration semantics.
- Replaced BigInt-per-byte FNV-1a with an exact two-32-bit-limb implementation.
  Fixed and 256 generated Unicode fixtures prove bit-for-bit compatibility with
  the original reference and preserve archive hashes.
- Passed the complete named Phase 5 gate after the final hash and privacy fixes:
  formatting, lint, typecheck, 64 Phase 1 tests, two rules properties, build,
  16 integration tests, production-browser E2E, 29 inference tests, one
  inference property, three truth-firewall tests, 95 simulator tests, 10
  evaluation tests, 62 solver tests, and three actor-safety tests.
- Captured and independently verified the immutable Phase 5 development latency
  smoke at `artifacts/search/phase5/phase5-smoke-final-20260727`: 30 Instant
  requests had p50 221.96 ms and p95 331.56 ms; 20 Balanced requests had p50
  729.55 ms and p95 1,132.26 ms. Both internal deadlines and service targets
  passed, payloads were deterministic, failures were zero, all five payload
  checksums verified, and the source snapshot was
  `115b379232db2413da979a173c3791f3e69daa6b92dc8f32bb24e244536f35f5`.
  This Node/tsx smoke is explicitly development-only, not Phase 8 release
  latency evidence.
- Accepted ADR 0005 for the hard-belief terminal root-rollout boundary, common
  random numbers, actor knowledge, clustered uncertainty, and stated
  limitations. Independent adversarial review found no remaining Phase 5
  correctness blocker.
- Implemented an alternative-aware behavioral overlay over every ordered hard
  world occurrence. Player 2 and Player 3 retain separate per-world conditional
  model mixtures; duplicate sampled occurrences retain their probability mass.
  Forced singleton moves are exactly neutral, every legal discretionary move
  has a positive lapse floor, and a global analytic exponent caps any one
  decision's model Bayes factor at four.
- Replayed behavioral evidence chronologically through actor-safe observations
  and exact hard-world hypotheses. Production behavior code has no simulator
  import or truth parameter, rejects stale hard support, and exposes model,
  ESS, entropy, world-weight, tempering, and per-decision diagnostics.
- Added paired truth-free calibration predictions for card owner, current void,
  suit length, overtake, joint, conditional, and full-alternative opponent
  action targets. The hard arm is uniform over each world's legal actions; the
  behavioral arm uses joint posterior world/model weights. Eval-only truth is
  joined by a separate scorer after prediction.
- Implemented the preregistered Brier/log-loss conventions, tie-aware action
  scoring, 50/80/95 categorical coverage, 10 fixed one-vs-rest reliability
  bins, query-to-family-to-state-to-trajectory-to-cluster aggregation, paired
  whole-cluster bootstrap intervals, and the calibration sample-size formula.
- Added immutable calibration artifacts with exact file sets, SHA-256 payload
  checksums, source/Git/environment/protocol/model/query/scorer hashes,
  truth-sidecar status for false conditioning events, atomic no-overwrite
  publication, and a verifier that regenerates counts, scores, intervals,
  reliability bins, hard-known preservation, and the reproduction digest.
- Hardened the calibration protocol around a frozen, full checkpoint schedule:
  initial, post-opening, three fixed public-event ordinals, first normal thulla,
  first visible pickup, and the second/fifth/eighth pre-choice checkpoints for
  each opponent. Colliding checkpoints retain every class reason while their
  shared information state is scored once.
- Added exact coordinate and stream validation, scenario/cluster joins,
  nested protocol weighting, separate hard-known/unresolved-soft and
  forced/discretionary strata, arm-specific denominator floors, true
  conditional-target semantics, source-race rejection, and run-label-independent
  seeds, identifiers, bootstrap samples, and reproduction digests.
- The artifact verifier now independently reconstructs every seeded game,
  checkpoint, prediction, truth join, and failure from the truth sidecar, checks
  canonical schedule/config/model/source hashes and raw-stream SHA-256 values,
  and byte-compares regenerated summaries, logs, and command metadata.
- Completed the hardened Phase 6 development calibration schedule: 17 ordered
  style cells × three deal rotations, 51 complete games, 603 unique
  checkpoints, 49,806 prediction records, 24,903 truth joins, and zero
  failures. All hard-known facts were preserved. Six logically possible
  zero-support outcomes were retained and scored as zero probability instead
  of being discarded.
- Stored and independently replay-verified the immutable artifact
  `artifacts/calibration/eval-v1/dev/phase6-calibration-dev-20260728-b`.
  It validates 10 files, 51 seeds, 49,806 predictions, and 24,903 pairs with
  reproduction digest `fnv1a64:8d2040d6749bc53e`.
- Development behavioral-minus-hard equal-family macro Brier improved by
  `-0.021045` (95% paired cluster-bootstrap CI
  `[-0.027031, -0.015056]`) and log loss improved by `-0.056818`
  (`[-0.075532, -0.038442]`). Card-owner, current-void, suit-length, and
  can-overtake families improved; the joint-family interval crossed zero,
  conditional evidence had only four observations, and Player 3 forced-action
  Brier worsened. This artifact is explicitly `evidenceEligible=false`, does
  not establish terminal noninferiority, and cannot enable production behavior.
- Completed the M01–M48 Phase 6 strategy ledger. Twenty-six required motifs
  have direct passing evidence; M39 exact endgame and M40 model sensitivity are
  explicit Phase 7 required deferrals; all 20 nonrequired motifs remain honest
  Phase 7 deferrals. No experimental motif or production feature was retained
  without measured evidence.
- Stored and verified the final immutable strategy artifact
  `artifacts/strategy/phase6/phase6-strategy-evidence-20260728-b`: 80 cited
  tests across 13 paths passed, all payload/link/checksum checks passed, and
  final-mode verification correctly fails only the two Phase 7 required
  deferrals.
- Accepted ADR 0006 for hard-support-preserving behavioral weighting,
  alternative-aware tempered likelihoods, the truth/calibration boundary, and
  qualification-only production eligibility. Behavioral weighting remains off
  in the live solver.
- Passed the complete dependency-ordered Phase 6 gate: formatting, lint,
  typecheck, production build, 64 Phase 1 tests, two rule properties, 16
  integration tests, production-browser desktop/mobile E2E, 43 inference
  tests, one inference property, three truth-firewall tests, 95 simulator
  tests, 10 evaluation tests, 93 search tests, three actor-safety tests, 61
  calibration tests, 22 strategy tests, and both immutable artifact verifiers.
- Added the Phase 7 research foundation: exact joint world × conditional
  Player 2 model × conditional Player 3 model mass, the full 7 × 7 model
  cross-product with duplicate occurrences retained, actor-safe policy kernels,
  information-state keys that exclude hidden truth, and model-sensitivity
  diagnostics.
- Implemented bounded exhaustive information-state DP with one shared user
  action per observable state, separate noncolluding Player 2/Player 3 policies,
  exact chance enumeration, vector terminal utility, semantic cycle refusal,
  typed structural/deadline/cancellation limits, and all-or-nothing `Exact`
  labeling. An independent nonmemoized oracle agrees on terminal and
  positional values in reduced positions.
- Added solver-derived exact diagnostics for immediate pickup/count, power,
  first-opponent-escape identity, and the eventual heads-up opponent. Dynamic
  rank, card-count/pickup, three-to-two-player, chance, strategy-fusion, and
  separate-opponent fixtures now exercise long-horizon consequences.
- Added stable/fragile model-sensitivity diagnostics, a research-only
  exact-then-frozen-Phase-5 dispatcher, hard-only deterministic continuation
  semantics for a clean ablation, and a production import firewall.
- Closed current M39/M40 direct correctness coverage while preserving the
  historical immutable Phase 6 26/22 artifact contract. The current Phase 7
  strategy verifier reports 28 required motifs retained and 20 nonrequired
  motifs deferred, with no production eligibility or enablement.
- Preregistered `phase7-paired-comparison-v1`: exact-off reference versus
  exact-on/frozen-fallback candidate, behavior weighting off, 17 cells, three
  rotations, crossed base-deal pairing, 20,000 base-index-cluster bootstrap
  resamples, and frozen exact limits of 7 active cards / 196 hypotheses / 128
  information states / 512 branches / 1,000 ms.
- Added an evaluation-only per-game user policy hook receiving only a detached,
  frozen public timeline, actor-safe observation, and solver seeds. It rejects
  unresolved private opponent draws/reveals, preserves the Phase 4 no-hook
  digest, and supports deterministic decision/latency auditing. The paired
  runner and immutable comparison artifact are implemented.
- A first no-write 102-game diagnostic completed all games with zero simulation
  failures and selected 21 Exact decisions, but artifact construction correctly
  failed on an exact-refusal audit-shape mismatch. No artifact or paired result
  from that invalid diagnostic is evidence. Adversarial review then found a
  solver/environment chance-seed collision, style-derived solver seeds,
  self-certified rerun reporting, incomplete decision-to-event coverage, and
  insufficient frozen-contract checks.
- Hardened the still-unreleased Phase 7 artifact contract to schema v2 before
  any valid Phase 7 evidence: direct Phase 5 reference execution, distinct
  private environment and style-neutral solver chance streams, recomputed seed
  and full-configuration contracts, setup/truth/action/observation replay
  binding, explicit 102/408/408 run kinds, before/after source snapshots, and a
  separate write-once three-artifact rerun attestation.
- Recorded and independently verified the valid immutable Phase 7 smoke at
  `artifacts/evaluation/eval-v1/dev/phase7-comparison-smoke-v2-20260728-a`:
  102/102 games, zero failures, 2,144 replay-bound decisions, 25 Exact uses,
  1,047 typed refusals, and no deadline or fallback-parity failure.
- Recorded and independently verified the immutable 408-game primary and fresh
  408-game reproduction at
  `artifacts/evaluation/eval-v1/dev/phase7-comparison-dev-primary-v2-20260728-a`
  and
  `artifacts/evaluation/eval-v1/dev/phase7-comparison-dev-reproduction-v2-20260728-a`.
  Each completed 204 games/configuration with zero failures, 8,654 validated
  decisions, 52 Exact uses, 4,275 typed refusals, no deadline refusal, and no
  fallback-parity failure. Reference and candidate each made the user Bhabhi in
  35/204 games; paired delta and 20,000-resample interval were exactly
  0 and [0, 0].
- Wrote and reverified the separate write-once reproduction attestation at
  `artifacts/evaluation/eval-v1/dev/phase7-reproduction-attestations/phase7-reproduction-4839c387e40a7cf714f9`.
  It binds the three manifests/checksum manifests and confirms the primary and
  reproduction scientific digest
  `sha256:4c9dfc7ae9ee15bba5e9a75b2883675adf2c1568b06eeba6cdd6503b1ff4d75f`.
- Preserved the failed
  `artifacts/strategy/phase7/phase7-strategy-evidence-20260728-a` write as
  non-evidence after it exposed a state-record canonical-order mismatch. Added
  a regression-tested canonicalization fix and wrote the fresh verified
  `artifacts/strategy/phase7/phase7-strategy-evidence-20260728-b`: all 28
  required motifs retained, 20 nonrequired motifs honestly unretained, and no
  experimental production feature enabled.
- Passed the complete dependency-ordered Phase 7 gate with an empty error log:
  format, lint, typecheck, production build, desktop/mobile E2E, all Phase 1–6
  suites and artifacts, 58 focused Phase 7 tests, the strategy artifact, all
  three comparison artifacts, and the cross-run attestation. The development
  tie retains direct frozen Phase 5 Balanced hard-only as the provisional
  production default; exact and behavioral weighting remain off pending clean
  Phase 8 eligibility.

## Phase gates

- [x] Phase 0: defaults, variants, metrics, holdout, and latency budgets explicit
- [x] Phase 1: rule, replay, and conservation tests pass
- [x] Phase 2: full manual game entry/correction/persistence/export flow passes
- [x] Phase 3: generated worlds valid and truth-firewall tests pass
- [x] Phase 4: reproducible invariant-safe baseline batches pass
- [x] Phase 5: uncertainty-aware terminal solver passes traps and live budget
- [x] Phase 6: behavioral inference evaluated and enabled only if eligible
- [x] Phase 7: exact toy agreement and eligible advanced-search result pass
- [ ] Phase 8: clean preregistered evaluation and stored evidence complete
- [ ] Phase 9: final regression, product hardening, and release criteria pass

## Commands executed

```text
git status --short --branch
git ls-files
git log --oneline --decorate -5
node --version
npm --version
git --version
Get-CimInstance Win32_Processor
Get-CimInstance Win32_OperatingSystem
Get-CimInstance Win32_VideoController
```

Phase 0 artifact validation:

```text
docs/progress.md                                                       4,521 bytes
docs/bhabhi-research.md                                               13,297 bytes
docs/strategy-model.md                                                13,355 bytes
docs/strategy-taxonomy.md                                             15,038 bytes
docs/evaluation-plan.md                                               20,368 bytes
docs/decisions/0001-local-first-functional-typescript-architecture.md  5,292 bytes
result: required files present, substantive, no placeholders
```

Phase 1 dependency and gate evidence:

```text
npm install
npm run gate:phase1

format:check  pass
lint          pass
typecheck     pass
rule/replay   11 files, 55 tests passed
property      2 tests passed
              deal seed 0x5eedc0de, 128 runs
              replay seed 0x1a2b3c4d, 64 runs, up to 30 events
production    Vite build passed
```

Phase 2 product and gate evidence:

```text
npm run gate:phase2

format:check  pass
lint          pass
typecheck     pass
rule/replay   11 files, 56 tests passed
property      2 fixed-seed tests passed
integration   3 files, 16 tests passed
production    Vite build passed
Playwright    desktop complete-game flow passed
              mobile live-tracker flow passed
              2 reciprocal project skips intentional

complete-game 61 active events including setup
              59 card plays, 1 explicit waste draw
              replay/conservation checked after every prefix
correction    event 60 changed from P2 TC to P2 5H
              same terminal Bhabhi, saved/reloaded/exported/imported
browser       Chromium production preview at desktop and Pixel 7 viewport
console       no browser console or page errors
```

Phase 3 inference and gate evidence:

```text
npm run gate:phase3

all prior gates       pass
inference             3 files, 29 tests passed
generated histories  1 fixed-seed property passed
                      seed 0x1f3e7e3, 32 runs, up to 24 events
truth firewall        2 files, 3 tests passed
production build      passed

initial support       C(34,17) = 2,333,606,220
                      C(35,18) = 4,537,567,650
tractable prefix      56 worlds; exact marginals, joints, and suit
                      distributions matched full enumeration
complete fixture      concrete truth retained at all 61 prefixes
hidden merge          multiple initial witnesses preserved even when
                      every current-hand projection was identical
independent review    no Phase 3 blocker or counterexample
```

Preliminary local Node smoke timing, not a production latency claim:

```text
command: npx tsx inline Phase 3 belief timing script
configuration: forced direct sample, 2,048 worlds, fixed seed
repetitions: 1 warm-up + 6 measured per cursor

cursor   min ms   median ms   max ms
1        324.92   349.76      437.28
20       273.75   321.95      343.49
40       260.18   290.56      330.38
61       240.48   274.95      288.04
```

Phase 4 simulator and artifact evidence:

```text
npm run test:simulator
4 files, 94 tests passed

npm run test:evaluation
3 files, 10 tests passed

npm run eval:phase4 -- --run-id phase4-smoke-a-final-20260727 --base-count 4
npm run eval:phase4 -- --run-id phase4-smoke-b-final-20260727 --base-count 4

each run             7 user policies x 17 cells x 4 deals x 3 rotations
                     1,428 complete games; 91,143 decisions
failures/caps        0 / 0
reproduction digest fnv1a64:d1e185b91f492a16 (identical)
source snapshot      4caef6bc8e1cf6d541d4aabbb9d2e8fc45a2e34065f13d45315539bce98a57cf
seed projection      e184598822711b0ea5aa5eb2c7dd2c159127042dc43bdcd37179988a619481e9

npx tsx scripts/verify-evaluation.ts --run <run-directory>
both runs            valid
each verifier        13 files; 1,428 truth replays; 91,143 decisions

descriptive dev user Bhabhi rates (204 games/policy; no CI/strength claim):
random               41.67%
always-high          37.25%
always-low           52.94%
shortest-suit        42.16%
early-high-shedder   38.24%
power-avoider        31.37%
documented-basic     11.27%
```

Phase 5 solver, gate, and development latency evidence:

```text
npm run gate:phase5
all prior gates       pass
phase1/rules/events  13 files, 64 tests passed
rules property        1 file, 2 tests passed
integration           3 files, 16 tests passed
Playwright            desktop + mobile flows passed; 2 reciprocal skips
inference             29 focused + 1 property passed
truth firewall        3 tests passed
simulator             4 files, 95 tests passed
evaluation            3 files, 10 tests passed
solver                5 files, 62 tests passed
actor safety          1 file, 3 tests passed

npm run bench:phase5 -- --run-id phase5-smoke-final-20260727 \
  --warmup 3 --instant-samples 30 --balanced-samples 20 \
  --power-mode "Windows Balanced; AC state not programmatically captured"

Instant              n=30; p50 221.96 ms; p95 331.56 ms; max 335.16 ms
Balanced             n=20; p50 729.55 ms; p95 1,132.26 ms; max 1,523.72 ms
internal p95 budgets Instant 500 ms PASS; Balanced 2,500 ms PASS
service p95 targets  Instant 750 ms PASS; Balanced 3,000 ms PASS
determinism/failures PASS / 0
evidence eligibility false (development Node/tsx smoke)

npm run bench:phase5:verify -- \
  --run artifacts/search/phase5/phase5-smoke-final-20260727
valid                true
files / records      5 / 50
overall gate         PASS
```

Phase 6 behavioral, calibration, and strategy evidence:

```text
npm run test:calibration
10 files, 61 tests passed

npm run test:inference
behavioral inference included; 43 tests passed

npm run eval:calibration -- --run-id phase6-calibration-dev-20260728-b \
  --split dev --base-count 1 --worlds 64

schedule              17 cells x 1 base deal x 3 rotations
games/checkpoints     51 / 603 unique complete
checkpoint classes   51 initial; 51 post-opening; 153 fixed-event;
                     51 post-thulla; 51 post-visible-pickup;
                     306 pre-opponent-choice
predictions/pairs     49,806 / 24,903
failures/zero support 0 / 6 logically possible outcomes scored at zero
hard-known preserved  true
behavior enabled      false
evidence eligibility false (development only)
reproduction digest  fnv1a64:8d2040d6749bc53e

npm run eval:calibration:verify -- \
  artifacts/calibration/eval-v1/dev/phase6-calibration-dev-20260728-b
valid                 true
files/seeds/pairs     10 / 51 / 24,903
predictions replayed 49,806

development equal-family behavioral-minus-hard:
Brier                -0.021045, 95% CI [-0.027031, -0.015056]
log loss              -0.056818, 95% CI [-0.075532, -0.038442]
clusters/resamples    17 / 20,000
behavior enabled      false

npm run gate:phase6
format/lint/typecheck/build pass
Phase 1              13 files, 64 tests; 2 rule properties
integration/E2E      16 tests; desktop/mobile flows pass
inference/firewall   43 + 1 property; 3 firewall tests
sim/evaluation       95 / 10 tests
search/actor safety  93 / 3 tests
calibration/strategy 61 / 22 tests
artifact verification strategy and calibration pass

npm run strategy:evidence:verify -- \
  artifacts/strategy/phase6/phase6-strategy-evidence-20260728-b
valid                 true
registry              48 motifs
required direct       26
Phase 7 deferrals     M39, M40 plus 20 nonrequired hypotheses/reported motifs
production enabled    0
```

Phase 7 comparison, strategy, and full-gate evidence:

```text
npm run eval:phase7:verify -- --run \
  artifacts/evaluation/eval-v1/dev/phase7-comparison-smoke-v2-20260728-a
valid/replayed        true / 102 games / 2,144 decisions
failures              0
Exact/refused         25 / 1,047

npm run eval:phase7:verify -- --run \
  artifacts/evaluation/eval-v1/dev/phase7-comparison-dev-primary-v2-20260728-a
npm run eval:phase7:verify -- --run \
  artifacts/evaluation/eval-v1/dev/phase7-comparison-dev-reproduction-v2-20260728-a
each valid/replayed   true / 408 games / 8,654 decisions
each failures         0
each Exact/refused    52 / 4,275
reference/candidate   35/204 Bhabhi / 35/204 Bhabhi
paired delta/95% CI   0 / [0, 0], 20,000 cluster resamples
scientific digest     sha256:4c9dfc7ae9ee15bba5e9a75b2883675adf2c1568b06eeba6cdd6503b1ff4d75f

npm run eval:phase7:verify-reproduction -- \
  --smoke <smoke> --primary <primary> --reproduction <reproduction> \
  --attestation artifacts/evaluation/eval-v1/dev/phase7-reproduction-attestations/phase7-reproduction-4839c387e40a7cf714f9
valid                 true
scientific rerun gate true

npm run strategy:phase7:evidence:verify -- --run \
  artifacts/strategy/phase7/phase7-strategy-evidence-20260728-b
valid                 true
registry              48 motifs
required direct       28
nonrequired deferred  20
production enabled    0

npm run gate:phase7
format/lint/typecheck/build pass
Phase 1              13 files, 64 tests; 2 rule properties
integration/E2E      16 tests; desktop/mobile flows pass
inference/firewall   43 + 1 property; 3 firewall tests
sim/evaluation       98 / 25 tests
search/actor safety  124 / 3 tests
calibration/strategy 61 / 24 tests
Phase 7 focused      16 files, 58 tests
artifact verification strategy, calibration, smoke, primary,
                      reproduction, and attestation pass
captured stderr       empty
```

## Open risks

- Household rules vary materially around taking another hand, zero cards with
  power, and two-player shootout semantics. Canonical defaults and the supported
  operational alternatives are fixed in `RuleConfig` and ADR 0002; further
  household variants remain unsupported until their semantics are explicit.
- Behavioral inference remains disabled for the first release. Development
  calibration is informative but cannot substitute for a browser-executable
  clean qualification route; ADR 0009 closes it as not applicable for this
  reference-only registry.
- The live tracker launches the production worker, verifies the release and
  request/result identity, publishes explanations/diagnostics, and invalidates
  stale work. The selected bundle cannot be generated until qualification and
  final evidence pass; an ordinary source build therefore reports analysis as
  unavailable by design.
- Eight GiB of physical memory constrains large particle sets and browser-based
  offline runs; budgets and worker memory need measurement.
- Rules sources are descriptive/community references rather than a formal
  governing body. Conflicts must be preserved in the unresolved-rule ledger.

## Next step

Commit the clean source candidate, run the 12-command frozen source validation,
and only then open qualification. Execute R-only qualification terminal and
browser latency, selection/final freeze, fresh final terminal and latency,
final attestation, selected-release build/latency, documentation finalization,
and the create-exclusive Phase 9 release-validation attestation. Do not modify
scientific source after qualification opens.
