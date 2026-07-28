# ADR 0010: Correct the evaluation latency worker route

- Status: accepted
- Date: 2026-07-28
- Phase: 8
- Applies after: abandoned qualification latency run
  `phase8-reference-qualification-latency-20260728-actions`

## Context

The first qualification browser run completed every scheduled request, but all
4,415 observations failed. Each worker response reported
`INVALID_RELEASE: The live production verifier refuses evaluation-only
bundles.` The latency harness imported and instantiated
`createBrowserAnalysisWorker`, even though ADR 0008 requires the benchmark entry
point to use the isolated evaluation worker and the dedicated
`createBrowserEvaluationAnalysisWorker` implementation already existed.

This is a route wiring defect, not a solver-quality or latency result. The
failed run is permanently abandoned. Its records cannot qualify any
configuration.

## Decision

The browser latency harness now instantiates the dedicated evaluation worker for
both ordinary requests and cancellation races. The live application continues
to instantiate the production worker, which still refuses evaluation-only
bundles. A regression test asserts the benchmark factory's worker module and
name.

No threshold, cell, seed policy, stopping rule, solver budget, configuration,
or selection rule changes.

Because executable source changed after the qualification opening, the prior
source attestation, authority, terminal run, and latency run are invalidated.
A new clean source attestation and qualification authority must be created, and
qualification and final evidence must be rerun from fresh immutable targets.

## Consequences

- The benchmark-only route can accept a source-bound `evaluation-only` bundle
  as preregistered.
- The shipped live worker's release firewall is unchanged.
- Evidence under the superseded source and authority remains diagnostic only
  and is never merged with replacement evidence.
