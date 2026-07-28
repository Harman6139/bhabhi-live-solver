# ADR 0001: Local-first functional TypeScript architecture

- Status: Accepted
- Date: 2026-07-27
- Scope: application structure and information boundaries
- Advanced solver algorithm: deliberately not selected by this ADR

## Context

The repository contains only the goal/configuration seed. The product must run
without a backend, share exact rules across UI, simulation, inference, search,
and tests, keep live entry responsive, support deterministic correction replay,
and make simulator hidden truth unreachable from production recommendations.

`GOAL.md` recommends React, TypeScript, Vite, Web Workers, Vitest, and
Playwright unless repository evidence justifies an alternative. No conflicting
repository constraint exists.

## Decision

Build one strict TypeScript project with React/Vite for the local application and
Node-compatible pure modules for simulation and evaluation.

Planned boundaries:

```text
src/
  domain/       cards, seats, typed rule configuration, shared values
  rules/        legal actions, transition reducer, trick/endgame resolution
  events/       canonical event schemas, replay, correction, hashing
  public/       public-information projection and diagnostics
  inference/    hard constraints, hidden worlds, correlated belief queries
  opponents/    separate uncertain policy models and likelihoods
  search/       terminal-risk action evaluation and exact endgames
  simulator/    hidden truth and complete-game drivers (guarded namespace)
  worker/       versioned/cancellable analysis protocol
  persistence/  IndexedDB event logs plus validated import/export
  ui/           React tracker and diagnostics
scripts/
  evaluation and reproducibility entry points
tests/
  unit, property, integration, truth-firewall, regression, and e2e fixtures
```

Rules, events, public projection, and search inputs are pure data and pure
functions. React does not own game semantics. Simulator truth is defined in a
guarded simulator module and is not an accepted parameter of production
inference/search APIs.

The canonical event log is persisted locally in IndexedDB. Derived snapshots are
caches identified by state hash and schema version. Import/export uses a
versioned runtime-validated JSON schema.

Inference and search run in a module Web Worker. Every request carries a state
version, state hash, budget, and seed. A new deterministic event aborts or
invalidates prior analysis; the main thread publishes a response only when both
version and hash match.

Evaluation runs the same pure rule/simulator/search code in Node. Raw artifacts
are machine-readable and summaries are generated from those artifacts, never
hand-transcribed.

## Why this is the initial choice

- One language and one rule core reduce divergence between the tracker,
  simulator, worker, and evaluation harness.
- Pure replay makes arbitrary correction, reproducibility, hashing, property
  tests, and stale-analysis invalidation auditable.
- Structural module boundaries allow TypeScript and dependency-lint tests to
  enforce the truth firewall.
- A worker preserves responsive physical-game entry.
- Native local persistence satisfies local-first/offline use without account,
  credentials, deployment, or a service process.
- The architecture supports direct constrained allocation, particles,
  information-set search, and exact endgames without committing to an
  unevaluated advanced algorithm.

## Rejected alternatives

### Backend service

Rejected for the production core because it violates the no-backend local-first
requirement, adds credentials/deployment, and complicates offline physical play.

### Separate Python solver process

Rejected for the shipped live path because installation and browser-process
coordination would be fragile. Python remains unnecessary for core evaluation;
an offline research script would need a later ADR and measured benefit.

### UI-owned mutable state

Rejected because corrections could leave stale constraints or posteriors and
because simulator/evaluation logic would drift from live rules.

### Independent-card marginals as the belief

Rejected by the contract and by the strategic need for joint overtake/void
queries. Marginals are derived diagnostics only.

### Selecting MCTS/CFR as architecture

Rejected at Phase 0. These are algorithms to prototype and gate, not organizing
principles. The simplest eligible terminal-risk method wins.

## Consequences

- Domain events and schemas require careful up-front typing.
- Worker messages must be serializable and versioned.
- Browser and Node entry points need dependency discipline.
- IndexedDB tests require a deterministic test adapter.
- Large offline experiments may be slower than native code; the evaluation gate
  will determine whether optimized data structures or a later narrowly scoped
  native/Wasm component is justified.

## Verification

This ADR is satisfied only when:

- dependency tests prove production inference/search cannot import simulator
  truth;
- replay of the same event sequence produces the same state hash;
- correction rebuilds all derived layers;
- worker stale-result tests pass;
- the Node simulator and browser tracker share the same transition functions;
- production build, typecheck, unit/property tests, and Playwright flow pass.
