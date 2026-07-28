# ADR 0009: Reference-only first release

- Status: accepted
- Date: 2026-07-28
- Phase: 8–9
- Applies before: any qualification or final split is opened

## Context

The route-specific browser harness currently authorizes only
`p8-r-hard-balanced-v1`. It explicitly rejects E, B, and BE so baseline timings
cannot be relabeled as advanced-role evidence. No clean train, tune,
qualification, or final split has been opened.

Running behavioral fitting and support tuning cannot make a role eligible while
its executable browser route is absent. It would add hours of unused work and
would not change the selected hard-only runtime.

## Decision

The first qualification registry contains only the frozen hard-only reference.
Qualification and final are genuine one-arm confirmations: they contain no
self-contrast, synthetic zero effect, or “beats” claim.

The authority binds a canonical `phase8-production-model-not-applicable`
artifact to the clean source hash. The terminal and production dispatchers
accept that artifact only when every frozen role is nonbehavioral. Any
behavioral role still requires the fully fitted and support-tuned production
model from ADR 0008.

Behavioral qualification calibration, support tuning, and behavioral component
gates are explicitly not applicable for this registry. Existing Phase 6
development calibration remains descriptive and cannot enable behavior.
Reference integrity is established by the clean source-validation suite,
truth-firewall tests, complete terminal matrices, route-specific browser
evidence, and final one-arm confirmation.

## Consequences

- The release remains hard-only unless a later clean protocol adds a genuinely
  executable and latency-certified advanced route.
- No behavioral result is invented, duplicated, or represented as
  confirmatory evidence.
- Qualification still selects through the frozen selection function and final
  remains fresh and independently seeded.
