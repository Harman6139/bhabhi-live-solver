# ADR 0008: Phase 8 evidence bundle and release binding

- Status: accepted
- Date: 2026-07-28
- Phase: 8–9
- Applies before: development sizing, qualification opening, or final opening

## Context

ADR 0007 freezes the confirmatory roles, statistics, eligibility rules, and
selection order. The individual terminal, calibration, and browser-latency
harnesses produce immutable checked artifacts, but a selection attestation with
only an opaque “artifact hash” could still be constructed from the wrong
directory or from a partial set of results.

The selected production worker also needs the final configuration, fitted-model
bytes, source identity, and selection attestation. Embedding those generated
values in source before evaluation would create a circular source hash; changing
source after evaluation would instead make the shipped worker differ from the
measured worker.

This decision freezes the aggregate evidence and generated-release boundary
before any clean result is opened.

## Decision

### Composite evidence is the attested artifact

Qualification and final each produce one canonical, create-exclusive evidence
bundle. Its payload SHA-256 is the artifact hash supplied to the corresponding
selection or final attestation. A separate canonical report projection has its
own SHA-256 and is the attestation’s summary hash.

The bundle verifier reopens and verifies every referenced artifact. It does not
accept caller-supplied Boolean gates without reproducing them from the bound
records.

Support regularization closes before the qualification authority exists. It
uses a distinct development/tune authority whose model hash is the exact
selected behavior-model artifact. That authority may open only the tune split
used by the support run and is never used to derive qualification seeds. After
the support selection is sealed, the selected behavior model and support
selection are combined into the final production-model bytes. Only then is the
qualification authority frozen, with `modelSha256` equal to those production
model bytes. The staged authority sequence avoids requiring one hash to equal
two different artifacts.

Before qualification, a second development-only preflight authority may bind
all four roles and the final production-model bytes for terminal variance and
route-specific browser measurements. It is never authorized with a
qualification opening. The actual qualification authority is frozen afterward
with only roles whose implementation, correctness, development sizing, and
latency prerequisites passed. If a qualification authority’s route-specific
latency verification unexpectedly fails before its split is opened, that
unopened authority is retained as abandoned and a new authority may omit the
failed role. Once a qualification opening exists, its configuration registry
cannot change.

A qualification bundle contains:

1. the frozen qualification authority and write-once qualification opening;
2. the verified terminal artifact and deterministic statistical report;
3. the verified two-arm calibration artifact when a behavioral role is in the
   qualification registry, otherwise an explicit not-applicable record;
4. one verified production-build browser-latency artifact for every
   configuration being considered;
5. the selected behavior-model and support-tune artifacts when behavioral
   roles are present;
6. a source-validation attestation containing the source snapshot, Git commit,
   commands, exit codes, log hashes, and required correctness/release-test
   results;
7. the complete per-configuration eligibility inputs and their provenance; and
8. a split-firewall audit proving that only the authorized qualification
   opening derived the clean seeds.

A final bundle contains:

1. the frozen final authority, write-once final opening, and immutable
   qualification selection attestation;
2. the verified fresh final terminal artifact and deterministic report;
3. the verified fresh final calibration artifact in the final manifest’s
   explicit mode;
4. verified production-build browser latency for the selected route under the
   final-manifest evaluation binding;
5. the unchanged source-validation identity;
6. the selected-model, selection, and final-manifest hashes used by that
   evaluation build;
7. the final integrity, confirmation, and split-firewall gates; and
8. exact links back to the qualification evidence bundle.

Each referenced item records its canonical payload SHA-256, semantic/scientific
digest where applicable, relative artifact path, manifest ID, manifest SHA-256,
split, configuration IDs, source SHA-256, model SHA-256, protocol SHA-256, and
verification result. Paths are locators only and do not contribute scientific
meaning; hashes and canonical payloads do.

### Terminal statistics are regenerated from complete raw outcomes

The aggregate report reads the verified terminal summary inputs and regenerates
the complete configuration-by-style-by-base-by-rotation matrix. Qualification
uses one 20,000-resample crossed paired max-statistic bootstrap for every frozen
candidate-versus-reference macro and style-cell contrast.

For each candidate, the report derives:

- equal-cell macro terminal Bhabhi rate and candidate-minus-reference contrast;
- simultaneous noninferiority, improvement, and practical-tie gates;
- every preregistered style catastrophe test and the combined style-safety
  gate;
- complete-matrix, zero-failure, zero-cap, zero-cancellation, replay,
  seed-coverage, and deterministic-regeneration gates; and
- exact-component incremental improvement independently for E and BE.

The reference has no synthetic candidate contrast. Its terminal
noninferiority gate means only that the verified reference arm is the frozen
fallback and completed every common integrity gate.

If final selects the reference, the terminal report is explicitly one-arm and
contains no bootstrap self-contrast or zero effect. If final selects a
candidate, only selected-minus-reference is tested with fresh final seeds.
Final confirmation requires terminal noninferiority and style safety. A
two-sided interval wholly below zero is additionally required before using the
word “beats.”

### Calibration and robustness gates are explicit

For a behavioral qualification role:

- `behaviorCalibrationGate` is the frozen primary equal-family unresolved-soft
  Brier simultaneous upper bound strictly below zero;
- `behaviorZeroSupportGate` requires zero raw-zero probability assignments to a
  logically possible realized label;
- `behaviorHardKnownPreservationGate` requires every hard-known prediction to
  remain exact;
- `behaviorSeparatePosteriorRobustnessGate` requires separate Player 2 and
  Player 3 posterior records, nonzero lapse/error support, bounded Bayes-factor
  updates, and the frozen noisy-action robustness tests to pass; and
- the common robustness gate also requires no prespecified secondary
  correctness or support failure.

These gates are independently applied to B and BE. BE cannot inherit either
behavioral or exact eligibility from B or E.

In a reference-selected final, calibration uses
`reference-one-arm-confirmation`. Behavioral contrasts and behavioral component
gates are recorded as not applicable, never as zero.

### Browser evidence is route-specific

Latency evidence is valid only when the production worker executes the exact
configuration ID and release binding recorded by the manifest. Relabeling
reference timings as E, B, or BE is invalid.

The common latency gate requires the preregistered release sample counts,
complete successful records, entry p95 at most 100 ms, no observed analysis
long task over 50 ms, Instant p95 at most 750 ms, Balanced p95 at most 3 seconds,
Deep p95 at most 20 seconds, and zero obsolete publications in at least 1,000
rapid-edit races. Memory observations are stored as measured values where the
platform exposes them; an unavailable metric must remain null with the exact
platform reason and may not be estimated or replaced with a label.

Because no numeric memory ceiling was preregistered, the memory gate means:
no allocation/OOM failure, observed page heap where supported, and honest
worker/process attribution or an explicit platform-unavailable record. The
final report must not describe an unavailable value as measured.

### Source validation is evidence, not prose

The source-validation attestation is created from a clean committed source
snapshot before qualification. It captures the required unit, property,
integration, truth-firewall, simulator, solver, calibration, type, lint,
format, production-build, and browser-test commands with exit status and
SHA-256 of complete logs.

The scientific snapshot excludes exactly `README.md`,
`docs/final-report.md`, and `docs/progress.md`, because those files receive
measured results only after holdout. Their exact final bytes and dry-run checks
belong to the post-selection release validation. Preregistration documents,
ADRs, tests, scripts, configuration, lockfiles, UI, worker, inference, and
solver source remain inside the scientific snapshot.

Qualification and final bundles reject:

- a dirty or different source snapshot;
- missing required command classes;
- a nonzero command;
- a mismatched log hash;
- a production model or configuration hash different from the authority; or
- a validation attestation created after the corresponding clean opening but
  claiming a different source.

The post-selection release validation may add only generated evidence data and
build output. Any source-code change invalidates the source attestation and
requires a new authority and clean rerun.

### Generated release data stay outside the source snapshot

Source code contains a browser-safe, role-neutral dispatcher and a strict
release-bundle schema. Before selection it exposes an explicit
`release-unselected` state and refuses production analysis.

The same worker supports a strict `evaluation-only` injected bundle for browser
qualification/final measurement before the corresponding attestation exists.
That bundle is bound to an exact manifest, configuration descriptor, model,
source, and protocol hash. It is accepted only by the benchmark entry point;
the live application refuses it. This is necessary because qualification
latency precedes selection, and final latency is itself an input to the final
attestation.

After the final attestation passes, a create-exclusive `release-selected`
artifact is generated under `artifacts/release/`. It contains:

- the selected configuration descriptor and allowed fallback contract;
- the selection and final attestation IDs and payload SHA-256 values;
- exact canonical selected-model bytes and their SHA-256;
- source, solver-configuration, protocol, scorer, and report hashes;
- final evidence-bundle and summary hashes; and
- a canonical bundle checksum.

Vite reads this external artifact at production-build time and injects its exact
canonical bytes into both the main bundle and worker. The worker independently
parses the bundle, verifies the model bytes and every binding field, and refuses
a caller whose binding differs. The main thread runtime-validates the complete
worker result before publication.

Generated release data do not change the evaluated source snapshot. A built
asset attestation proves which external release bytes were embedded and binds
the built worker back to the final attestation.

The exact `release-selected` build then receives a separate create-exclusive
Phase 9 release-validation attestation. It covers its built-asset hashes,
route-specific browser latency, cancellation races, product E2E/accessibility,
README clean-directory dry run, final documentation bytes, and debug
truth-firewall. Goal completion requires this release attestation. Phase 8’s
final attestation cannot claim to cover a release bundle that did not yet
exist.

## Consequences

- No opaque directory or hand-entered Boolean can authorize selection or final
  release.
- Qualification and final remain reproducible from raw records rather than
  trusting a prose summary.
- A reference-selected final is scientifically one-arm throughout terminal and
  calibration reporting.
- The shipped worker can be data-bound after selection without changing the
  measured implementation.
- Any missing, unverifiable, or platform-unavailable measurement remains
  explicit and cannot silently become a pass claim.
