# ADR 0011: Resolve public-history ties and persist terminal shards

- Status: accepted
- Date: 2026-07-29
- Phase: 8
- Applies after: superseded GitHub Actions run `30409430508`

## Context

The replacement qualification terminal runner attempted all 3,264 frozen
scenario coordinates. It recorded 3,262 complete games and two `EVENT_CAP`
outcomes at the unchanged 4,096-event safety cap, then correctly refused to
emit a passing statistical report. The failed run and its uploaded artifact
remain diagnostic evidence.

Both capped games used the hard-only reference. At recurrent public states,
multiple root actions had bit-identical computed Bhabhi risk. The v1 solver
always resolved such ties by canonical card order, so the same three actions
repeated indefinitely. Fixed batches of four also made unrelated workers wait
at each batch boundary while a recurrent game consumed its worker.

## Decision

The hard-only and behavior-weighted approximate algorithms advance to v2.
Computed risk remains the primary ordering without tolerance or rounding. Only
bit-identical risk ties are ordered by a stable hash of:

- the public semantic history hash;
- the public-state hash;
- the frozen search-seed identifier; and
- the candidate action key.

Canonical action order remains the hash-collision fallback. No hidden hand,
truth record, future outcome, threshold, stopping rule, solver budget, sample
size, bootstrap count, or event cap enters this tie resolution.

Terminal execution becomes completion-driven rather than fixed-batch. The
complete frozen authority plan can be partitioned by ascending base index.
Each shard retains every configuration, all 17 style cells, all three
rotations, replicate zero, and the frozen seeds for its base indices.

GitHub orchestration uses 39 modulo-base shards on 39 standard four-core Linux
runners, alongside one browser-latency runner. Every terminal shard uploads an
independent artifact containing the raw record streams, evaluation-only truth
stream, original authority/opening/model bytes, environment and command,
record counts, exact expected and observed coordinate digests, the complete
plan scientific hash, per-file SHA-256 checksums, and a shard scientific
digest. Matrix failure cancellation is disabled.

Canonical merge and final attestation are deliberately downstream operations.
A merge must reject a changed authority, source, plan hash, shard count,
partition rule, checksum, duplicate coordinate, missing coordinate,
unexpected coordinate, failed game, or incomplete 0-through-63 base-index
partition. Successful shards never need recomputation merely because another
shard or the later merge fails.

## Consequences

- The two capped games require a clean rerun under a new source attestation and
  authority; no record from the superseded source can be mixed into evidence.
- Exact-risk choices remain deterministic, reproducible, public-only, and
  seed-bound while avoiding static canonical lock-in across evolving history.
- Scientific coverage and release criteria are unchanged.
- Expensive raw compute can finish and remain durable before canonical merge,
  report generation, qualification selection, final opening, and Phase 9
  release assembly.
