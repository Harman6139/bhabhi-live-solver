# Final Report

## Release status

Phase 8 is complete and the selected R engine is model-ready. The full GOAL is
not yet complete: Actions run 30480677017 stopped in the final Phase 9
attestation when `prettier --check` reported Windows formatting differences in
304 files. That job failed before the remaining regression commands and did not
create the release-validation artifact. No model, terminal, or latency compute
failed, and none of the expensive Phase 8 work needs to be repeated.

## 1. Product

The project is a local-first three-player Bhabhi / Getaway manual tracker and
decision assistant. It includes typed household rules, event-sourced replay and
correction, card conservation, correlated hidden-hand inference, terminal-risk
search, a truth-separated simulator/evaluation stack, a dedicated browser
worker, stale-result rejection, persistence, archive import/export, and
user-facing explanations.

The selected production route is the hard-only Balanced reference
`p8-r-hard-balanced-v1`. It ranks actions by estimated terminal Bhabhi risk;
pickup risk, power, hand size, and immediate shedding are diagnostics rather
than the primary objective.

## 2. Rules and information integrity

The canonical profile is clockwise: A-spades opens, following suit is
compulsory, the opening trick completes and goes to waste, and the first later
off-suit thulla ends its trick so the highest lead-suit player picks up. Typed
variants cover direction, opening restrictions, take-hand behavior,
zero-cards-with-power behavior, and the implemented two-player transition.

Production inference and search receive only public history. Exact simulator
truth stays behind tested import and metamorphic firewalls. Visible pickups,
chronological voids, hand counts, waste, and card conservation remain hard
constraints.

## 3. Frozen source and evidence chain

- Scientific source: `phase8-source-b82e68a` /
  `b82e68a56b914197328dbef0a8e519207e8f47b7`
- Complete release DAG: Actions run 30480677017
- Qualification: 39 independently durable terminal shards, deterministic merge,
  and browser latency
- Final: 39 untouched terminal shards, deterministic merge, final browser
  latency, selection/final attestations, and selected release construction
- Selected release artifact: `phase8-recovery-selected-release-30480677017-1`
  (artifact 8743116265)
- Selected release bundle SHA-256:
  `1acc6726cf38867ed393eb86a52a9a10208b4ae50f2ddeaa2b6d01d21f5b0de9`
- Release source binding:
  `0e8dfe629c4a2580d3de65ee8d8150afa2ba90f48a8d2ee95b4368c5841602ef`
- Protocol binding:
  `371ad4a6abef5ceb97c404cd5f4fc848f567db180d79351753eb6234cc250693`

The selected artifact was imported locally and 20/20 internal checksum entries
passed. The exact frozen source also built successfully with the embedded
`release-selected` bundle.

## 4. Terminal results

The first release registry is genuinely reference-only. These are one-arm
confirmations, not evidence that R beats another configuration.

| Split           | Complete games | User Bhabhi | Bhabhi rate | Failures/caps/cancellations |
| --------------- | -------------: | ----------: | ----------: | --------------------------: |
| Qualification   |          3,264 |         445 |    13.6336% |                           0 |
| Untouched final |          3,264 |         446 |    13.6642% |                           0 |

Final finishing counts were 1,068 first (32.72%), 1,750 second (53.62%), and
446 third/Bhabhi (13.66%). The final terminal runner's p95 decision latency was
519.07 ms.

## 5. Selected-route browser latency

The exact selected-release route completed 3,400/3,400 measured requests with
zero failures. All 1,000 cancellation races completed with zero obsolete
publications. The reproduction digest is `fnv1a64:30be373f4fa1e208`.

| Mode     | Warm wall p95 |
| -------- | ------------: |
| Instant  |     159.56 ms |
| Balanced |     405.33 ms |
| Deep     |   2,374.41 ms |
| Offline  |  15,364.74 ms |

The selected-route runner was a GitHub-hosted Windows machine with 4 logical
CPUs, 16 GiB RAM, Node 22.13.0, and Chromium 151.0.7922.34. Dedicated-worker
CPU and memory attribution are unavailable through the browser APIs and were
not estimated.

## 6. Model inventory

- R (`p8-r-hard-balanced-v1`): selected, final-confirmed, release-bundled, and
  ready.
- E (`p8-e-exact-hard-fallback-v1`): implemented as an exact attempt with
  byte-identical R fallback, but only available in an evaluation-only practical
  bundle; not formally selected or qualified.
- B and BE: behavior train/tune and all 30 support shards completed, but sealing
  rejected 10,338 raw zero-feasible-truth observations. They have no production
  bundle and no valid performance result.

The B/BE failure is not a request for more blind computation. The model/support
logic must be diagnosed first; only then can the existing durable shards be
rescored if that is scientifically valid.

## 7. Compact play build caveat

The compact play branch embeds the verified R bundle but intentionally requests
Deep analysis and adds a post-freeze same-suit high-card preference for exactly
tied terminal-risk estimates. The formal 13.66% result covers frozen Balanced R,
not those post-freeze play-build choices. Deep did pass operational latency and
cancellation testing, but it has no separate terminal-rate claim.

When the user starts with 17 cards, the identity of the opponent holding 18
cards cannot be inferred from A-spades ownership alone. The current compact
setup uses that shortcut, so 17-card starts require a household/deal assumption
or a future belief mixture before they can be called fully evidence-aligned.

## 8. Remaining release work

One focused Phase 9 validation/attestation run remains after locally fixing the
Windows checkout line-ending behavior. It must reuse the existing selected
bundle, run the skipped format/lint/typecheck/regression/build/firewall/E2E and
clean-install checks, and create the missing attestation. No Phase 8 training,
terminal evaluation, or latency run is required.
