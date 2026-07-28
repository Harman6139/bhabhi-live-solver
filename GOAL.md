# Goal Specification: Strongest Practical 3-Player Bhabhi / Getaway Live Solver

## 1. Outcome

Build a production-quality, local-first decision assistant for a human playing a real, physical, three-player game of Bhabhi / Getaway.

The user manually records:

- their initial hand;
- each card played by the user, Player 2, and Player 3;
- visible pickups and rule events;
- corrections to earlier entries.

From only information legitimately observable by the user, the application must maintain the public game state, reason over correlated hidden-hand possibilities, learn separate uncertain behavior models for both opponents, evaluate every legal user action, and recommend the action that minimizes:

`P(user is the final player holding cards | public history and active rule profile)`

This terminal Bhabhi probability is the primary objective. Hand size, immediate pickup risk, current trick outcome, power, and finishing first are diagnostics or tie-breakers only when they help the terminal objective.

The deliverable is a complete, runnable project, not a design document or isolated AI prototype. It must include the live tracker, rules engine, inference and solver layers, simulator, tests, reproducible evaluation tooling, user-facing explanations, and honest documentation of limitations.

## 2. Execution Contract

Treat this file as an outcome, invariant, and release-gate contract. Suggested algorithms are candidates, not mandatory implementation choices.

- Inspect the repository before assuming its state. If it contains only goal documents, initialize the application in this project root.
- Research rules and relevant imperfect-information methods before locking the advanced architecture.
- Prefer the simplest approach that wins on correctness, terminal decision quality, calibration, robustness, and live latency.
- Prototype competing high-impact choices when evidence is insufficient. Record the decision and evidence in `docs/decisions/`.
- Keep rules, public state, hidden truth, inference, opponent modeling, search, UI, and evaluation cleanly separated.
- Keep the project runnable and tested at every phase gate.
- Maintain `docs/progress.md` with the active phase, completed gates, evidence, commands, artifacts, open risks, and next step.
- Use subagents for genuinely independent research, test design, benchmark analysis, or review work when useful. Avoid overlapping writes; the primary agent owns integration and final judgment.
- Resolve routine engineering decisions autonomously. Pause only for a genuinely blocking household-rule decision, unavailable credential or permission, destructive/external action, or material scope expansion.
- Local file creation and edits, project-local dependency installation, public-source research, and non-destructive tests and benchmarks are in scope. Deployment, publication, paid services, purchases, and external writes are not authorized.
- Never fabricate citations, benchmark runs, sample counts, confidence intervals, calibration results, screenshots, or completion evidence. Clearly distinguish implemented infrastructure from experiments actually executed.
- Do not weaken rules, tests, schemas, information boundaries, or required behavior merely to make a build pass.
- Do not mark the goal complete until the final release gates in this file pass. If a true blocker remains, document the evidence, exhausted alternatives, and smallest user decision required.

## 3. Research and Preregistered Evaluation

Before finalizing the advanced solver, produce:

- `docs/bhabhi-research.md`
- `docs/strategy-model.md`
- `docs/strategy-taxonomy.md`
- `docs/evaluation-plan.md`
- at least one architecture decision record in `docs/decisions/`

Research credible sources for:

- documented Bhabhi / Getaway rules, terminology, regional and household variants;
- written and community strategy discussions, including South Asian sources where useful;
- existing digital games, bots, and open-source implementations;
- Bayesian hidden-state inference, sequential Monte Carlo, constrained allocation sampling, opponent modeling, bounded rationality, information-set and belief-state search, multiplayer utility, determinization pathologies, CFR-family approaches where relevant, exact endgames, probability calibration, and strategy discovery.

For each source-derived claim, record a citation and separate:

1. documented rules;
2. commonly reported strategy;
3. plausible but unvalidated hypotheses;
4. solver-discovered or experimentally supported strategy.

Internet folklore is a hypothesis source, not a rule or heuristic to hardcode.

Before tuning against results, preregister in `docs/evaluation-plan.md`:

- primary and secondary metrics;
- opponent-style suite;
- state/game sampling method;
- seed policy and paired-comparison design;
- confidence-interval method;
- sample-size or compute stopping rule;
- latency budgets and test hardware reporting;
- component ablations;
- criteria for enabling an advanced component in the production configuration.

Do not move evaluation thresholds after seeing results without documenting the change and rerunning a clean holdout.

## 4. Canonical Default Rules

Implement this explicit default profile while centralizing variants in a typed `RuleConfig`.

### Deck and deal

- Three active players.
- Standard 52-card deck; no jokers and no trump.
- Ace high through 2 low.
- The full deck is dealt; starting hand counts are a permutation of 18, 17, and 17.
- The user's cards are known exactly. Opponent allocations remain uncertain unless public evidence makes them exact.

### Opening trick

- The holder of A♠ opens by playing A♠.
- Other active players must follow Spades if able and otherwise may play off-suit.
- Under the default profile, an opening off-suit card does not terminate the trick. All active players play.
- Opening cards go to waste; nobody picks them up.
- The A♠ player has power and leads the next trick.
- An opening off-suit play proves the player had no Spades immediately before that action.

### Normal tricks

- The power-holder leads any card; its suit is the lead suit.
- Later players must follow the lead suit if able and may choose any rank in that suit. They need not beat the current highest card.
- A player void in the lead suit may play any off-suit card: a thulla / thola / tochoo.
- Under the default profile, the first thulla ends the trick immediately. Later seats do not act.
- Of the lead-suit cards already played, the highest card's owner picks up the entire trick, retains or receives power, and leads next.
- If everyone follows suit, the trick goes to waste and the highest lead-suit card's owner receives power.

### Escape and loss

- A player who legitimately eliminates all cards escapes and becomes inactive, subject to the active zero-cards-with-power rule.
- The final player holding cards is Bhabhi.
- Seat order, active-player order, exact thulla termination, power, and the transition to two players are first-class rules.

### Centralized variants

At minimum make these explicit and tested:

- clockwise versus anticlockwise direction;
- taking another hand: disabled, next active player, adjacent player, or configured household behavior;
- zero cards while retaining power: immediate escape, waste draw, or configured take/draw behavior;
- opening off-suit: any off-suit versus highest off-suit;
- applicable two-player shootout/endgame behavior.

If a variant cannot be sourced confidently, keep the canonical default deterministic, document the uncertainty, and expose the alternative only after its semantics are explicit. Never scatter variant checks across unrelated logic.

## 5. State, History, and Information Integrity

### State layers

Maintain explicit separation among:

1. `PublicInformationState`: everything the human user could legitimately know;
2. simulator/test hidden truth: never reachable by production recommendation code;
3. `HiddenWorld`: one exact hypothetical opponent allocation consistent with public information;
4. belief/inference state: probability mass or another justified representation over valid hypotheses;
5. search state: a simulation node whose actors receive only their legitimate information.

Useful domain concepts will likely include `Card`, `PlayerState`, `TrickState`, `RuleConfig`, `GameEvent`, `GameState`, `PublicInformationState`, `HiddenWorld`, `BeliefState`, `OpponentModel`, and `SearchState`, but naming is an implementation decision.

### Event-sourced corrections

Use event sourcing or equivalently deterministic replay semantics. Cover:

- game creation and hand initialization;
- card plays and thullas;
- trick completion, pickup, and waste;
- power changes;
- escape and two-player transition;
- take-hand and random-draw events;
- correction, undo, and redo.

Every edit or correction must rebuild all affected deterministic and probabilistic state from the corrected history. No stale constraint, behavioral likelihood, particle, posterior, or recommendation may survive.

### Card conservation

Every concrete game state and hidden world must account for all 52 cards exactly once across the user's hand, known opponent ownership, unresolved hidden allocation, current trick, waste, or a rule-specific holding area.

Card-accounting failure is a release blocker. Add aggressive unit, property, fuzz, replay, and invariant tests.

### Truth firewall

Production output must not depend on simulator truth. Add a metamorphic test:

- hold public history, solver configuration, and RNG seed fixed;
- vary the simulator's hidden truth among deals consistent with that history;
- verify that production belief construction and recommendations are identical.

Perfect-information agents may exist only in simulator/testing namespaces with explicit guardrails.

## 6. Hard and Soft Evidence

Rules and exact observations dominate all probabilistic models.

### Hard evidence

Examples:

- thulla in Hearts proves the player was Hearts-void immediately before that action;
- a visible pickup gives exact ownership of each picked-up card until observed leaving;
- hand counts restrict allocation slots;
- waste, current trick, played cards, known cards, and the user's hand are mutually exclusive locations;
- chronological follow-suit legality constrains past ownership.

Impossible worlds have probability zero.

### Soft behavioral evidence

A voluntary legal choice changes relative probabilities according to how likely that action was under the player's uncertain policy. The model must evaluate the alternatives the player could legally have chosen, not only whether the observed card was possible.

Conceptually:

`weight'(world, model) ∝ weight(world, model) × P(observed action | world, public state, player model)`

- Forced actions should have appropriately high likelihood.
- Discretionary low/high choices, suit selection, thulla selection, power seeking/avoidance, suit depletion, trap creation, and escape timing may be evidence.
- Strange but legal human moves normally retain nonzero likelihood.
- Use bounded rationality, error mixtures, likelihood tempering/floors, model ensembles, or another empirically supported safeguard against unjustified posterior collapse.

Authority order:

1. game rules;
2. exact observations;
3. exact pickups and known ownership;
4. chronological void/follow-suit deductions;
5. hand counts and card conservation;
6. behavioral evidence.

### Temporal ownership

Voids are chronological facts, not permanent booleans. A player who was Hearts-void can later acquire Hearts through a visible pickup. Known picked-up cards remain exact components of that hand until played.

## 7. Correlated Belief and Opponent Models

Preserve card-ownership correlations. Do not use independent card marginals as the internal world model when exact allocations or another correlated representation are practical.

Every valid hidden world must satisfy:

- current hand counts;
- known cards and visible pickups;
- waste, trick, and observed plays;
- chronological void/follow-suit constraints;
- rule legality;
- exact card conservation.

There are only two hidden opponent hands, so investigate direct constrained combinatorial assignment and incremental repair before relying on wasteful rejection sampling.

If using weighted particles, implement and test normalization, effective sample size, resampling, constraint-preserving rejuvenation, entropy diagnostics, deterministic seeding, and collapse safeguards. Benchmark particle methods against simpler enumeration or constrained sampling in tractable states.

Expose marginals and joint/conditional queries derived from the correlated representation, for example:

- `P(Player 2 owns A♥)`;
- `P(Player 3 is currently void Hearts)`;
- expected suit length;
- probability of exactly one card in a suit;
- `P(Player 2 can overtake 6♦ and Player 3 then thullas | history)`.

Maintain separate uncertain models for Player 2 and Player 3. Candidate tendencies include high-card shedding, low-card preservation, suit depletion, power preference, thulla aggression, positional awareness, endgame awareness, risk, skill, rationality, and random error. These are hypotheses to validate, not mandatory permanent features.

One surprising action must not classify a player with near certainty. Behavioral inference remains enabled in production only when calibration, hidden-state prediction, action prediction, robustness, or downstream terminal decision quality improves on a clean evaluation.

## 8. Decision Search

For each legal user action `a`, estimate:

`P(user becomes Bhabhi | do(a), public history, posterior worlds, opponent-model uncertainty)`

Rank by terminal Bhabhi probability. Secondary diagnostics may include safe probability, escape-first/second probability, expected finishing position, pickup probability and size, power probability, future hand structure, information effects, and sensitivity to opponent assumptions.

Use common sampled worlds and random numbers across candidate actions where practical. Report approximate ties when uncertainty does not support a ranking.

The search must:

- model Player 2 and Player 3 as separate self-interested players, not a colluding minimax adversary;
- preserve each simulated actor's information set and avoid strategy fusion;
- propagate the identity of the opponent who escapes and the resulting two-player matchup;
- represent genuine random rule events as chance nodes;
- value information through downstream consequences where feasible, not an arbitrary information bonus;
- progressively replace approximation with exact enumeration/dynamic programming in tractable late states, especially heads-up;
- label output `Exact` only when it is exact under the active rules and behavior assumptions;
- provide learned-human expectation and sensitivity or robust-ensemble diagnostics when model uncertainty matters.

Evaluate weighted determinization, root sampling, information-set search, belief-state/POMCP-style search, Bayesian or multiplayer MCTS, MaxN/vector utility, CFR-family methods where applicable, and exact endgame methods. Select by evidence, not terminology.

## 9. Required Strategic Competence

The solver must discover or correctly evaluate, without relying on one global card score:

- the option value of shedding the final card in a suit;
- state-dependent high-card value;
- the danger or benefit of leading into a known/likely void;
- seat-sensitive low-card thulla traps;
- thulla as active card shedding, pickup forcing, turn denial, and power manipulation;
- intentional power transfer;
- the identity and timing of the first opponent to escape;
- hand quality beyond card count;
- moves that sacrifice immediate shedding for a better terminal structure.

Required deterministic trap:

`User → Player 2 → Player 3`, Player 3 known void Diamonds, Player 2 has J♦, and the user can lead 4♦ or Q♦.

- After 4♦, Player 2's J♦ is highest when Player 3 thullas, so Player 2 picks up.
- After Q♦, the user remains highest when Player 3 thullas, so the user picks up.

The rules engine must produce those consequences exactly. Search must strongly distinguish the actions when those consequences change terminal value.

Also test a correlated probabilistic version, such as a belief where Player 2 can beat 4♦ in 60% of worlds, can beat Q♦ in 20%, and Player 3 is void Diamonds in 85%, without naively multiplying unrelated marginals.

## 10. Strategy Discovery

After the simulator is correct and before finalizing opponent features or rollout heuristics:

- generate dozens of candidate motifs across hand, suit, rank, power, thulla, position, information, manipulation, escape timing, three-to-two-player transition, endgame, behavioral tells, deception, and noise;
- use exact small-state solving, counterfactual analysis, self-play, state mining, and counterexample search;
- find states where common heuristics reverse or counterintuitive actions dominate;
- retain a motif as a production feature only when it improves a measured outcome or is required for correctness.

Each entry in `docs/strategy-taxonomy.md` must state:

- description and rationale;
- example state;
- required engine capability;
- counterexamples or boundary conditions;
- evidence status;
- reproducible test or experiment.

## 11. Simulator and Evaluation

Build a complete-game simulator separate from the live UI, supporting reproducible seeds, self-play, and:

- random legal;
- always-high and always-low;
- shortest-suit preference;
- high-card early shedder;
- power avoider;
- a documented heuristic Bhabhi agent;
- learned player-model and search agents;
- perfect-information agents for testing only.

The infrastructure should scale to large offline experiments, but report only runs actually completed.

At minimum compare:

- random user policy;
- always-high;
- always-low;
- strongest documented basic heuristic;
- search with hard constraints but no behavioral inference;
- each material advanced component through ablation;
- final production configuration.

Use mixed opponent styles and paired seeds/deals. Report Bhabhi rate, finishing positions, absolute and relative deltas, confidence intervals, calibration, compute cost, p50/p95 latency, stability across seeds, and sensitivity to opponent models.

The shipped production configuration must be the strongest measured eligible configuration under the preregistered terminal metric and live compute budget. If an advanced component degrades results, calibration, robustness, or latency, disable or simplify it rather than keeping it for sophistication.

Claims such as “beats baseline,” “calibrated,” or “exact” require the corresponding evidence. If a comparison is inconclusive, say so.

## 12. Calibration

Build a synthetic calibration harness where simulator truth is hidden from the production inference path. Compare constraint-only inference with constraint-plus-behavioral inference using:

- Brier score;
- log loss;
- reliability/calibration curves;
- interval coverage;
- relevant joint/conditional prediction accuracy;
- action prediction;
- downstream terminal decision quality.

Use train/tune/evaluation separation for behavioral parameters and solver choices. Avoid evaluating only on the same simulated policies used to fit the model.

Displayed probabilities must identify the analysis method and uncertainty. Do not turn sampling noise or a fragile behavioral posterior into false precision.

## 13. Live Product

Unless repository evidence justifies a compatible alternative, use React, TypeScript, Vite, Web Workers, Vitest, Playwright, and modern responsive styling. Keep core functionality local-first with no backend dependency.

The tracker must reliably support:

1. new game, seating, and rule configuration;
2. complete starting-hand and hand-count entry;
3. automatic turn and legal-card determination;
4. one-step card recording for all players;
5. opening, follow-suit, thulla termination, pickup, waste, power, escape, and heads-up transition;
6. exact user-hand updates and visible opponent-pickup ownership;
7. undo, redo, arbitrary earlier correction, deterministic replay, and stale-analysis cancellation;
8. local persistence, refresh restoration, import, and export;
9. continuous recommendation on user turns;
10. responsive keyboard and pointer entry while analysis runs.

Optimize for a moving physical game:

- approximately one interaction for the normal next card;
- keyboard aliases such as `qh`, `10d`, and `as`;
- only physically possible cards shown when appropriate;
- user cards disappear after play;
- invalid input produces a specific, recoverable explanation;
- analysis never blocks card entry.

Default to a clear dark interface:

- players, counts, power, and known/estimated voids;
- current trick, entry controls, and history;
- recommendation, alternatives, probabilities, uncertainty, and explanation;
- the user's exact hand;
- collapsible belief, opponent-model, and search diagnostics.

Accessibility, readable card/suit distinctions, keyboard operation, responsive layout, and correction ergonomics are acceptance criteria, not polish-only extras.

## 14. Worker, Cancellation, and Performance

On every new event or correction:

1. update and validate deterministic public state immediately;
2. cancel or invalidate obsolete analysis by version/token;
3. rebuild or update belief state from the valid history;
4. launch new analysis in a worker;
5. publish only results whose state version still matches;
6. progressively improve the recommendation where useful.

Provide configurable budgets:

- `Instant`: near-immediate approximate result;
- `Balanced`: default live result;
- `Deep`: larger live analysis;
- `Offline`: post-game or position analysis.

Preregister concrete budgets in `docs/evaluation-plan.md`. Target, on the documented development machine:

- deterministic entry feedback at p95 ≤ 100 ms;
- no main-thread task caused by analysis exceeding 50 ms;
- an Instant recommendation at p95 ≤ 750 ms;
- a Balanced recommendation at p95 ≤ 3 seconds.

If hardware or algorithmic evidence requires different thresholds, document the measured reason and preserve responsive entry. Never present an obsolete recommendation for a newer state.

## 15. Recommendation and Explanation

On the user's turn, show:

- recommended legal card;
- estimated Bhabhi and safe probabilities;
- escape-first/second estimates where defensible;
- immediate pickup and power diagnostics;
- ranked alternatives with uncertainty or tie labels;
- analysis method, budget, sample/world count, seed or reproducibility identifier, and quality label;
- model-sensitivity warning when the choice is fragile.

Explanations must be causal and generated from engine diagnostics, action-value decomposition, or counterfactual comparisons. They must identify why the recommendation changes terminal risk—for example, a downstream thulla causes a different player to pick up—not repeat generic strategy advice.

Clearly distinguish:

- `Known`: logically exact from observations and rules;
- `Inferred`: probabilistic belief;
- `Model-sensitive`: dependent on uncertain opponent behavior;
- `Approximate`: sampling/search estimate;
- `Exact`: exhaustively solved under stated assumptions.

Never invent a post-hoc story or display more precision than the estimator supports.

## 16. Diagnostics and Reproducibility

Provide a developer/debug view and exportable snapshot containing:

- app/version and active rule profile;
- canonical public history and state hash;
- analysis state version and RNG seed;
- known cards, hard constraints, and chronological void evidence;
- posterior entropy, representation/world count, and effective sample size where relevant;
- per-action behavioral likelihood contributions;
- Player 2 and Player 3 model posteriors;
- search method, iterations, depth/horizon, budget, elapsed time, and cancellation status;
- candidate estimates, intervals, and sensitivity results.

All reported experiments must be reproducible from committed code plus recorded command, configuration, seed policy, environment, raw result artifact, and summary script.

## 17. Mandatory Tests

### Rules and state

- full canonical opening and normal-trick behavior;
- first-thulla termination and skipped later seats;
- highest lead-suit pickup ownership;
- waste and power;
- all supported variants;
- escape and two-player transition;
- arbitrary undo/redo/correction replay;
- import/export round trip;
- card conservation under generated histories.

### Inference

- forced versus discretionary low-card likelihood;
- gradual high-card-shedding and suit-depletion updates;
- one noisy legal action does not collapse the posterior;
- temporal void restored by visible pickup;
- picked-up cards remain exact until played;
- valid worlds satisfy every hard constraint;
- truth-firewall metamorphic test;
- correlated queries match enumeration in tractable toy states.

### Strategy and search

- deterministic and probabilistic low-card thulla traps;
- immediate shedding versus future position;
- downstream value of becoming void;
- opponent escape identity changes terminal value;
- dynamic high-card value in multiple contexts;
- distinct multiplayer utility rather than two-player minimax;
- chance-node correctness;
- exact solver agreement with brute-force toy positions;
- common-random-number candidate comparison reproducibility.

### Product

- complete simulated game entry without AI;
- correction during active worker analysis;
- stale result cannot overwrite a newer state;
- local persistence and restoration;
- keyboard entry;
- responsive/mobile layout and accessibility smoke checks;
- production build and browser end-to-end flow.

## 18. Phases and Gates

Work in dependency order; parallelize only independent work.

### Phase 0: Discovery and preregistration

Deliver repository assessment, rules/strategy/solver research, unresolved-rule ledger, initial ADR, and evaluation plan.

Gate: canonical defaults, open variants, success metrics, holdout method, and latency budgets are explicit.

### Phase 1: Exact rules and event core

Implement typed cards, rules, reducer/replay, trick resolution, card accounting, variants, corrections, state hashing, and persistence model.

Gate: rule, replay, and conservation tests pass.

### Phase 2: Manual live tracker

Build the usable, fast, local physical-game interface without depending on advanced AI.

Gate: a full game can be entered, corrected, saved, restored, exported, and completed.

### Phase 3: Hard inference

Implement exact known ownership, chronological voids, slot constraints, valid correlated hidden-world construction, and truth firewall.

Gate: all generated worlds are valid and leakage tests pass.

### Phase 4: Simulator and baselines

Implement complete games, seeded agents, batch execution, raw artifacts, and baseline reports.

Gate: reproducible batches run without invariant failure.

### Phase 5: Baseline imperfect-information solver

Evaluate every legal user action across plausible worlds with legitimate information sets and terminal utility.

Gate: recommendations use uncertainty, pass trap/toy tests, and run within a measured budget.

### Phase 6: Behavioral inference and strategy discovery

Implement forced/discretionary likelihood, separate noisy player models, calibration harness, counterfactual mining, and completed strategy taxonomy.

Gate: advanced inference is calibrated/evaluated and enabled only where it improves preregistered metrics.

### Phase 7: Advanced multiplayer search and endgame

Integrate the best measured belief/search method, robust model handling, positional diagnostics, and exact/near-exact late solving.

Gate: exact toy positions agree with brute force; search passes long-horizon tests and improves or safely matches the eligible baseline.

### Phase 8: Evaluation and ablation

Run the preregistered suite, calibration analysis, component ablations, latency profiling, and sensitivity analysis on clean evaluation seeds.

Gate: the selected production configuration is justified by stored evidence.

### Phase 9: Product hardening and release

Complete explanations, diagnostics, accessibility, cancellation, error recovery, documentation, and final regression suite.

Gate: all final validation and release criteria pass.

## 19. Final Release Criteria

The goal is complete only when:

- canonical rules and supported variants are explicit and comprehensively tested;
- every card is conserved across rules, replay, corrections, simulation, and hidden worlds;
- production code cannot access or react to hidden truth;
- hard evidence removes impossible worlds and soft evidence never overrides facts;
- visible pickups and temporal voids behave correctly;
- Player 2 and Player 3 can develop different, uncertainty-aware behavior models;
- correlated hidden-hand dependencies are preserved for strategic queries;
- every legal user action is evaluated against terminal Bhabhi risk;
- seating, first-thulla termination, suit depletion, dynamic rank value, power, escape identity, and heads-up transition affect decisions correctly;
- the production solver is the strongest eligible measured configuration under the preregistered metric and live budget;
- exact claims are verified and approximate outputs expose uncertainty;
- calibration and ablation results are stored and honestly interpreted;
- arbitrary corrections rebuild deterministic and probabilistic state with no stale output;
- the UI stays responsive and rejects obsolete worker results;
- explanations are traceable to actual computation;
- unit, property, integration, end-to-end, type, lint/format, production-build, simulator, benchmark, calibration, and regression checks pass as applicable;
- a fresh user can install, run, play, test, and reproduce the principal evidence from the README;
- remaining limitations and unsupported variants are documented without hiding release-critical gaps.

The final report must list:

1. what was built;
2. active default rules and supported variants;
3. architecture and key decisions;
4. validation commands and results;
5. benchmark/calibration results with sample counts and intervals;
6. latency results and hardware;
7. enabled and rejected experimental components;
8. known limitations and next highest-value work;
9. exact paths to runnable artifacts and reproducibility data.

## 20. Explicit Design Failures

Any of these is a release-blocking failure:

- choosing one random opponent deal and treating it as truth;
- reading simulator hidden truth in production inference or search;
- modeling only voids while ignoring exact pickups, counts, and action evidence;
- treating behavioral evidence as certainty or letting it contradict facts;
- permanently treating a player as void after a visible pickup restores that suit;
- destroying relevant card correlations through unsupported independent marginals;
- ignoring rejected legal alternatives when modeling voluntary choices;
- treating both opponents as identical forever or as one colluding adversary;
- leaking hidden information to simulated actors;
- ignoring seat order, first-thulla termination, power, escape identity, or the two-player transition;
- using a universal static card rank/value table as the decision engine;
- equating fewer cards with a better state;
- optimizing immediate shedding instead of terminal Bhabhi probability;
- displaying stale, uncalibrated, or falsely precise recommendations;
- blocking live input with inference/search;
- leaving stale evidence after correction;
- retaining an advanced component that measured worse merely because it sounds sophisticated;
- claiming research or experimental evidence that was not actually obtained.

## 21. Final Standard

The finished system must answer:

> Given every public observation, which correlated opponent hands remain possible; how should voluntary choices and rejected alternatives change their probabilities; what do those choices reveal about each specific opponent; how will those opponents likely act without seeing information unavailable to them; what multi-step consequences follow from every legal user move through position, thullas, pickups, power, suit structure, escape order, and heads-up play; and which move has the best defensible terminal survival profile?

Optimize relentlessly for the one outcome that matters:

**minimize the probability that the user is the final player holding cards.**
