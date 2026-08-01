# Getaway Live Solver

A local-first, three-player Bhabhi / Getaway tracker and decision aid. It
records a public game timeline, preserves card-accounting invariants, maintains
correlated hidden-hand uncertainty, and evaluates every legal user action by
estimated terminal Bhabhi risk in a dedicated browser worker.

No game data or analysis is sent to a server. IndexedDB persistence, archive
import/export, inference, and search all run on the device.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer
- Chromium installed by Playwright for browser tests

## Install and run

```powershell
npm ci
npx playwright install chromium
npm run dev
```

Open the local URL printed by Vite. For a production preview:

```powershell
npm run build
npm run preview
```

The prepared local play build is documented in `PLAY-PREVIEW.md`; its default
`dist/` uses practical E (exact endgame with R fallback) and is ready to serve:

```powershell
node scripts/serve-play-preview.mjs dist
```

To reproduce the formally selected R build instead, inject its verified bundle:

```powershell
$env:BHABHI_RELEASE_BUNDLE_PATH = (Resolve-Path "artifacts/release/phase9-reference-release-20260729-d2/production-release-bundle.json")
$env:BHABHI_RELEASE_EXPECT_MODE = "release-selected"
npm run build
npm run preview
```

The selected R bundle from Actions run 30480677017 is the strongest formally
qualified release. Its untouched-final Bhabhi rate was 446/3,264 (13.66%) under
the Balanced configuration. E is the recommended practical build because it
attempts exact endgame search and otherwise falls back to R. B and BE are also
packaged for local experimentation using the real fitted behavior artifact,
but remain explicitly unsealed and have no win-rate claim.

## Play

1. Choose who received the 18th/extra card and who plays Hukam (A♠ opener).
2. Enter your exact starting hand; the other hand counts are automatic.
3. Record each observed card. New compact sessions run counterclockwise.
4. On your turn, use the single card shown as **Top engine move**.
5. Use **Undo** to correct the latest entry, and export the game for a backup.

The rules engine records off-suit thulla events and transfers every table card
to the correct picker before updating all three counts.

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

`npm run release:verify` runs the formatting, lint, type, complete unit and
regression suite, production build, and browser E2E suite in one command.

## Reproduce the principal evidence

The immutable raw artifacts are local under `artifacts/` and are excluded from
Git because of their size. Each run contains checksums and a verifier-readable
manifest. The final measured paths and results are catalogued in
`docs/final-report.md`.

The first release follows ADR 0009's preregistered reference-only path. It does
not claim that the reference beats itself, and it does not relabel an
unimplemented advanced worker route. From the clean Phase 7 baseline and its
verified development artifact, the dependency order is:

```powershell
npm run eval:phase8:prepare-reference

$qa = "artifacts/evaluation/eval-v1/qualification/authorities/phase8-reference-qualification-20260728-a"
npm run eval:phase8:create-corpus -- --authority "$qa/phase8-manifest-authority.json" --output "$qa/latency-corpus.json" --corpus-id "phase8-reference-qualification-latency-20260728-a"
npm run eval:phase8:create-bundle -- --authority "$qa/phase8-manifest-authority.json" --model "$qa/model-not-applicable.json" --config-id "p8-r-hard-balanced-v1" --output "$qa/evaluation-bundle.json"
$env:BHABHI_RELEASE_BUNDLE_PATH = (Resolve-Path "$qa/evaluation-bundle.json")
$env:BHABHI_RELEASE_EXPECT_MODE = "evaluation-only"
npm run build
npm run eval:phase8:terminal -- --scope qualification --authority "$qa/phase8-manifest-authority.json" --opening "$qa/qualification-opening.json" --model "$qa/model-not-applicable.json" --output-root "artifacts/evaluation/eval-v1/qualification/terminal" --run-id "phase8-reference-qualification-terminal-20260728-a" --concurrency 4
npm run bench:latency -- --evidence-eligible --run-id "phase8-reference-qualification-latency-20260728-a" --manifest "$qa/qualification-manifest.json" --corpus "$qa/latency-corpus.json" --config-id "p8-r-hard-balanced-v1" --dist dist --power-mode "Windows Balanced" --power-source "AC power" --background-load "no-controlled-background-load"
npm run eval:phase8:qualify-reference -- --authority-directory "$qa" --terminal-run "artifacts/evaluation/eval-v1/qualification/terminal/phase8-reference-qualification-terminal-20260728-a" --terminal-report "artifacts/evaluation/eval-v1/qualification/terminal/phase8-reference-qualification-terminal-20260728-a-statistical-report.json" --latency-run "artifacts/evaluation/eval-v1/qualification/phase8-latency/phase8-reference-qualification-latency-20260728-a"
```

The qualification command freezes and opens the final authority. Repeat corpus,
evaluation-bundle, production-build, terminal, and latency commands against
`artifacts/evaluation/eval-v1/final/authorities/phase8-reference-final-20260728-a`;
then run `npm run eval:phase8:finalize-reference` with the resulting final paths.
The exact expanded final and Phase 9 commands, hashes, sample counts, and
hardware record are preserved in `docs/final-report.md`.

Do not edit executable source, preregistration, tests, scripts, or lockfiles
after qualification opens. Generated evidence is create-exclusive: use a new
run ID for a genuine clean rerun.

## Architecture and limitations

The application is strict TypeScript and React. Pure rules/replay, hard
inference, behavior research, terminal search, evaluation-only simulator truth,
production release verification, worker protocol, and UI layers have explicit
boundaries. Production inference/search/worker/UI imports are guarded by a
transitive truth firewall.

The first selected release is the measured hard-only Balanced reference. Exact
endgame and behavioral weighting remain disabled because no browser-executable,
cleanly eligible advanced route was available before the split opened. Rule
sources are community descriptions rather than a governing standard; choose a
supported profile that matches the household before play.
