# Getaway Live Solver

A local-first, three-player Bhabhi / Getaway tracker and decision aid. It
records the public game, preserves card-accounting and truth-firewall
invariants, maintains correlated hidden-hand uncertainty, and evaluates every
legal user action by estimated terminal Bhabhi risk in a dedicated worker.

No game data or analysis is sent to a server.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer
- Chromium installed by Playwright for browser tests

## Download the selected release evidence

The source is commit `b82e68a56b914197328dbef0a8e519207e8f47b7`. The external selected bundle is
kept outside the scientific source snapshot and can be downloaded from the
successful [release Actions run](https://github.com/Harman6139/bhabhi-live-solver/actions/runs/30480677017):

```powershell
gh run download 30480677017 --repo Harman6139/bhabhi-live-solver --name "phase8-recovery-selected-release-30480677017-1" --dir artifacts
```

Locate `production-release-bundle.json` under
`artifacts/phase9-reference-release-20260729-d2/`,
then build the exact selected application:

```powershell
npm ci
npx playwright install chromium
$env:BHABHI_RELEASE_BUNDLE_PATH = (Resolve-Path "artifacts/phase9-reference-release-20260729-d2/production-release-bundle.json")
$env:BHABHI_RELEASE_EXPECT_MODE = "release-selected"
npm run build
npm run preview
```

An ordinary source build still supports setup, tracking, corrections,
persistence, import, and export, but deliberately refuses production
recommendations until a verified `release-selected` bundle is injected.

## Play

1. Select the rule profile and enter your exact starting hand.
2. Record each public play, pickup, waste draw, player draw, or take-hand event.
3. On each user turn choose Instant, Balanced, Deep, or Offline analysis.
4. Read the recommendation, ranked legal alternatives, terminal-risk estimate,
   uncertainty label, causal explanation, and public-only diagnostics.
5. Use Correct, Undo, or Redo at any time; obsolete analysis is cancelled and
   can never overwrite the corrected state.
6. Export the canonical archive for a portable local backup.

## Test

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:property
npm run test:integration
npm run test:truth-firewall
npm run test:simulator
npm run test:solver
npm run test:calibration
npm run test:e2e
```

`npm run release:verify` runs the formatting, lint, type, complete regression,
production-build, and browser E2E suite. The create-exclusive Phase 9
attestation additionally replays these checks from a fresh clean worktree and
verifies the selected-route latency/cancellation evidence.

## Reproduce the principal evidence

The first release follows ADR 0009's preregistered reference-only path and ADR
0011's independently durable shard protocol. Exact commands, sample counts,
hashes, latency distributions, hardware, selected/rejected components, and
artifact IDs are in [docs/final-report.md](docs/final-report.md).

The complete dependency-safe run is
[GitHub Actions 30480677017](https://github.com/Harman6139/bhabhi-live-solver/actions/runs/30480677017). It reuses 39 verified
qualification shards, opens final only after qualification passes, runs 39
untouched-final shards alongside final browser latency, creates the selected
bundle, measures that exact route, and executes Phase 9 release validation.

Do not edit executable source, preregistration, tests, scripts, or lockfiles
after qualification opens. Generated evidence is create-exclusive; use a new
authority and run ID for a genuine scientific rerun.

## Architecture and limitations

Strict TypeScript separates rules/replay, hard inference, behavior research,
terminal search, simulator truth, production release verification, worker
protocol, and React UI. Production code is guarded by a transitive truth
firewall. The selected route is hard-only Balanced; behavioral weighting and
exact-endgame dispatch remain disabled because they were not eligible in this
frozen browser-executable registry. Unsupported household variants require an
explicit typed profile.
