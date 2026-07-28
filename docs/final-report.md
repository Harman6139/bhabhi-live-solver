# Final Report

This report is finalized only after the create-exclusive Phase 8 qualification,
final, and Phase 9 release-validation artifacts pass. The implementation below
is source-frozen; measured clean-split fields will be replaced from artifacts
without changing the scientific source snapshot.

## 1. What was built

A local-first three-player Bhabhi / Getaway manual tracker and live solver:
typed rules and event replay, exact card conservation, correlated hard
inference, research-only behavioral inference, terminal-risk search, a
truth-separated simulator/evaluation stack, a verified dedicated-worker
production route, stale-result rejection, explanations, diagnostics,
corrections, IndexedDB persistence, and archive import/export.

## 2. Default rules and supported variants

The default is the documented Pagat-style clockwise profile: A-spades opening,
compulsory follow, opening trick completed normally, later first off-suit play
ends the trick, highest lead-suit holder picks up, and the implemented Pagat
heads-up transition. The closed `RuleConfig` also exposes the tested opening,
direction, zero-power, take-hand, draw/waste, and heads-up alternatives.
Household rules outside that closed set are unsupported.

## 3. Architecture and key decisions

The source uses pure strict TypeScript cores with React at the UI boundary.
Public inference and search cannot import simulator truth. Production analysis
runs in a dedicated worker and verifies an embedded release bundle plus every
request/result identity. ADRs 0001–0009 record the architecture, inference,
simulation, solver, confirmation, evidence-bundle, and reference-only release
decisions.

## 4. Validation commands and results

The frozen Phase 8 source-validation suite contains format, lint, typecheck,
complete unit/regression, property, integration, truth-firewall, simulator,
solver, calibration, production build, and browser E2E commands. Phase 9 adds
the exact selected build, selected-route product/accessibility E2E, a clean
worktree `npm ci` dry run, and release attestation. Clean artifact-derived
command counts and hashes are not yet recorded in this pre-run version.

## 5. Benchmark and calibration results

The selected first-release registry is genuinely one-arm and reference-only.
Behavior train/tune, behavior qualification calibration, component contrast,
and support regularization are therefore not applicable, rather than reported
as synthetic zero effects. Qualification/final terminal sample counts, Bhabhi
rates, and intervals will be copied from the immutable reports after execution.

## 6. Latency results and hardware

Browser evidence uses production Chromium, warm/cold Instant, Balanced, and Deep
requests, Offline requests, deterministic input probes, long-task observation,
and 1,000 cancellation/stale-publication races. The initial machine is Windows
11, Intel Core i5-9300H (4 cores / 8 logical processors), approximately 8 GiB
RAM, Node.js 22.13.0. Exact artifact-measured p50/p95 values and environment
fields will be copied after execution.

## 7. Enabled and rejected experimental components

Enabled: the direct Phase 5 Balanced hard-only reference route.

Disabled: behavioral weighting and exact-endgame production dispatch. They
remain implemented and tested as research components but cannot be represented
as release-eligible without a genuine browser worker route and clean evidence.
The release makes no “beats” claim against itself.

## 8. Known limitations and next work

The tracker is manual and supports exactly three starting players. Community
rule sources conflict, so unsupported household semantics require an explicit
new profile. The current uncertainty intervals describe the implemented
sampling/model assumptions, not unknown model misspecification. Browser APIs do
not expose attributable dedicated-worker CPU/memory on this platform; unavailable
metrics are reported with reasons. The next highest-value work is a genuinely
executable advanced route followed by a new preregistered qualification.

## 9. Runnable artifacts and reproducibility data

Expected create-exclusive roots:

- qualification authority and opening:
  `artifacts/evaluation/eval-v1/qualification/authorities/phase8-reference-qualification-20260728-a`
- qualification terminal/latency/evidence bundles:
  `artifacts/evaluation/eval-v1/qualification/`
- final authority, terminal/latency/evidence bundle:
  `artifacts/evaluation/eval-v1/final/`
- selected production bundle and Phase 9 validation:
  `artifacts/release/`

The exact successful paths, payload hashes, reproduction digests, and release
validation digest will replace these pre-run descriptions directly from the
artifacts.
