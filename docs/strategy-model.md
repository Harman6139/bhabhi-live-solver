# Strategy and Solver Model

Status: Phase 0 architecture hypothesis. Advanced components remain gated by the
preregistered evaluation in `docs/evaluation-plan.md`.

## Decision objective

For every legal user action \(a\), estimate:

\[
P(\text{user is Bhabhi}\mid do(a),\ \text{public history},\
\text{rules},\ \text{model uncertainty})
\]

The production rank is ascending terminal Bhabhi probability. Card count,
pickup size, power, suit shape, and finishing order are diagnostics or causal
explanation terms; none replaces the terminal objective.

## Authority and information order

1. Active `RuleConfig`
2. Exact public observations
3. Exact known ownership from visible pickups
4. Chronological follow-suit and void deductions
5. Counts and 52-card conservation
6. Soft action likelihood under uncertain player models

An impossible world always has zero probability. A behavioral model may
redistribute mass only among hard-valid worlds.

## Layered state model

The implementation keeps the following types and modules structurally separate:

- `PublicInformationState`: public event replay, exact user hand, counts, trick,
  waste, power, active order, known opponent cards, and chronological evidence.
- `SimulationTruth`: complete deal used only by simulator/test entry points.
- `HiddenWorld`: one exact two-opponent allocation consistent with public
  information.
- `BeliefState`: normalized correlated worlds, weights, diagnostics, and
  queries.
- `OpponentModelState`: separate uncertain policy parameters/posteriors for
  Player 2 and Player 3.
- `SearchState`: a simulated node exposing each actor only to its own hand,
  public observations, and permitted model state.

Production recommendation APIs accept no `SimulationTruth` type. A dedicated
metamorphic test changes simulator truth while holding public history,
configuration, and seed fixed.

## Event-sourced correction model

The canonical source of truth is an immutable list of typed `GameEvent` values.
State, constraints, posterior worlds, opponent models, and recommendations are
derived artifacts keyed by a deterministic event-log hash and monotonically
increasing analysis version.

Undo, redo, and arbitrary correction produce a new active event sequence and
replay from game creation. All probabilistic state is rebuilt from that sequence.
Worker results publish only when both state hash and analysis token still match.

## Correlated hidden-hand representation

With exactly two hidden opponents, an initial allocation is determined by
assigning a constrained subset of unseen initial cards to Player 2; Player 3
receives the complement. At the start, the raw space can be as large as
\(\binom{35}{17}=4,537,567,650\), so exhaustive enumeration is not an early-game
plan. One opponent bitset plus deterministic event replay compactly preserves
all ownership correlations, exact slots, past legal alternatives, pickups, and
chronological voids.

### Hard-constraint construction

Phase 3 will build a chronological constraint ledger:

- observed plays and waste remove exact cards from hands;
- the user hand is exact;
- visible pickups add exact cards to the picker until those cards are observed
  leaving;
- each off-suit play constrains which still-held cards could have belonged to
  that actor at that event;
- active hand counts fix remaining slots;
- every card has exactly one location.

The default constructor uses count-aware dynamic programming/backtracking over
per-card allowed-owner masks and feasible completion counts. It samples directly
from feasible initial allocations instead of repeatedly shuffling full deals,
rejecting them, or using biased coin-flip-then-repair. When the feasible count is
small enough, it enumerates exactly.

Every returned world is independently validated by deterministic chronological
replay. This validator is a release guard, not a substitute for the direct
constructor.

### Weighted belief

The first behavioral implementation uses fresh importance weighting:

1. draw deterministic i.i.d. worlds from the current hard posterior;
2. replay the complete corrected public history;
3. compute each world's alternative-aware behavioral log likelihood;
4. normalize with log-sum-exp.

This is correction-safe by construction and must be benchmarked before adding a
persistent filter.

If fresh recomputation fails the measured latency/ESS gate, an eligible SMC
implementation may add:

- deterministic seeding;
- log-space weights and stable normalization;
- effective sample size and entropy diagnostics;
- systematic resampling only below a preregistered ESS threshold;
- constraint-preserving mutation/repair;
- likelihood tempering and a nonzero random-error mixture;
- exact enumeration in tractable states;
- rebuild-from-history after every correction;
- resample-move proposals with valid target/proposal correction, including
  opponent-type state rather than arbitrary repair.

Card marginals are derived views, never the internal independence assumption.
Joint queries execute directly over worlds, including conditional trap
probabilities.

Bootstrap filtering and resample-move are supported by the original particle
filter and MCMC rejuvenation literature:
[Gordon, Salmond & Smith 1993](https://doi.org/10.1049/ip-f-2.1993.0015) and
[Gilks & Berzuini 2001](https://doi.org/10.1111/1467-9868.00280).

## Separate opponent models

Player 2 and Player 3 each maintain their own posterior mixture. Candidate policy
families include:

- random legal;
- rank-low and rank-high preference;
- shortest-suit / suit-depletion preference;
- early high-card shedding;
- power seeking and power avoidance;
- thulla aggression;
- positional and escape-aware heuristic play.

These are hypotheses. Production starts from a broad mixture and keeps
behavioral inference disabled unless the clean evaluation makes it eligible.

For world \(w\), player model \(m\), public state \(s\), and observed legal action
\(a\):

\[
L(a\mid w,m,s) =
(1-\epsilon)\operatorname{softmax}(f_m(a,w,s)/T)

- \epsilon / |\mathcal{A}(w,s)|
  \]

The likelihood denominator includes every legal alternative the player could
have chosen in that world. Forced actions contribute no artificial evidence.
Tempering, a probability floor, broad priors, and model averaging prevent one
odd move from collapsing the posterior. The exact safeguards and parameters are
tuned only on the tune partition and are tested by the calibration harness.

The logit form is a candidate bounded-response model, motivated by quantal
response rather than claimed as a fact about Getaway players:
[McKelvey & Palfrey 1995](https://doi.org/10.1006/game.1995.1023).
Bayesian poker modeling provides precedent for separating hidden game dynamics
from opponent-policy uncertainty:
[Southey et al. 2005](https://webdocs.cs.ualberta.ca/~mbowling/papers/05uai.pdf).

## Baseline decision search

The first eligible search is weighted root sampling with common random numbers:

1. draw a correlated world/model pair from the belief;
2. evaluate every legal user root action on that same draw and rollout seed;
3. simulate each opponent using that opponent's private hand and public
   information only;
4. carry each player's own terminal utility, escape identity, power, active
   order, and the resulting heads-up matchup;
5. continue to terminal Bhabhi identity, including typed chance draws;
6. aggregate weighted paired outcomes and intervals.

This baseline is deliberately simple enough to audit. It does not let a rollout
actor inspect another hand, does not let the user condition future choices on the
sampled truth, and does not treat both opponents as a colluding minimax player.
When a perfect-information oracle is used in tests, vector MaxN-style backup is
the relevant noncoalition comparator, with the limitation that its foundational
setting is complete information:
[Luckhardt & Irani 1986](https://cdn.aaai.org/AAAI/1986/AAAI86-025.pdf).

Common worlds and random streams reduce variance between candidate actions.
The recommendation may label actions approximately tied when paired uncertainty
does not support a stable order.

## Advanced search candidates

### Information-set MCTS

Cowling, Powley, and Whitehouse search information-set trees rather than a
separate perfect-information tree per determinization:
[paper and DOI](https://doi.org/10.1109/TCIAIG.2012.2200894).
ISMCTS is a plausible live candidate because Getaway has discrete actions and a
generative simulator. It still requires careful re-determinization/information
handling at each actor.

### Belief-state / POMCP/BAMCP-style search

Silver and Veness combine particle belief updates with Monte Carlo tree search
using a black-box generative model:
[NeurIPS paper](https://papers.nips.cc/paper/4031-monte-carlo-planning-in-large-pomdps.pdf).
POMCP is directly relevant to belief-rooted online planning, but vanilla POMCP
models a single decision maker interacting with an environment; separate
self-interested opponent policies and multiplayer information sets must be
represented explicitly here.

The preferred advanced prototype is therefore a user action-observation history
tree: draw initial deal and opponent types at the root; group opponent activity
until the next user decision into an environment macro-step; key user nodes only
by public history/state hash; and let each opponent act from its own information
view. BAMCP supports root sampling over latent model uncertainty:
[Guez, Silver & Dayan 2012](https://proceedings.neurips.cc/paper_files/paper/2012/hash/35051070e572e47d2c26c241ab88307f-Abstract.html).
This is a Bayesian best response to modeled humans, not a claim of multiplayer
equilibrium.

### Weighted determinization

Perfect-information Monte Carlo is fast and often useful in trick-taking games,
but it can condition future choices on the sampled hidden world. Frank and Basin
analyze failures of Monte Carlo search in imperfect-information games:
[DOI](<https://doi.org/10.1016/S0304-3975(00)00083-9>).
Long et al. study when PIMC succeeds or fails:
[AAAI paper](https://ojs.aaai.org/index.php/AAAI/article/download/7562/7423).

Weighted determinization is therefore an ablation and rollout accelerator, not
an automatic production choice. Any version must show that it avoids material
strategy-fusion errors on targeted tests.

### CFR-family methods

Counterfactual regret minimization was introduced for extensive-form imperfect
information games:
[Zinkevich et al., NeurIPS 2007](https://papers.nips.cc/paper/3306-regret-minimization-in-games-with-incomplete-information.pdf).
The complete three-player game, variant state, and human-style uncertainty make
full online CFR impractical for the initial product. CFR remains a candidate for
small abstractions, offline strategy discovery, and exact-toy cross-checks. It
will not be retained merely for theoretical sophistication.

## Exact and near-exact endgames

When the hard-valid world count and remaining cards are below measured
thresholds, the solver switches to enumeration and memoized dynamic programming.
After one opponent escapes, the remaining opponent hand becomes known by
52-card complement whenever the active rule profile has no unresolved holding
area; this is an especially valuable exact boundary.

- enumerate all correlated worlds with their normalized weights;
- enumerate legal action/chance branches under the stated opponent-policy model;
- memoize canonical state plus information/model state;
- retain vector terminal outcomes until the user's terminal loss probability is
  aggregated;
- include the identity of the first escape and heads-up rules.

Pickup rules can create state cycles, so the endgame backend must detect strongly
connected components or solve the applicable absorbing stochastic process
rather than assuming a finite acyclic trick tree.

“Exact” means exhaustive under the displayed rules, belief support, opponent
policy assumptions, and chance distribution. Exact perfect-information solving
alone is never labeled an exact public recommendation.

## Causal explanations

Each action result records observable computation terms:

- immediate pickup owner/probability and expected pickup size;
- power probability;
- suit depletion/void transition;
- which opponent escapes first;
- transition to heads-up opponent;
- model/world sensitivity;
- paired counterfactual events that changed terminal outcomes.

Explanations select the largest reproducible counterfactual differences. The
mandatory Diamond trap should produce a concrete statement such as: leading 4♦
lets Player 2's J♦ remain highest before Player 3's known thulla, so Player 2
picks up; leading Q♦ leaves the user highest and forces the user to pick up.

## Production eligibility

An advanced belief, behavior, or search component is enabled only if it:

- preserves every hard invariant and the truth firewall;
- improves the preregistered clean terminal metric, or safely matches it while
  materially improving calibration/latency/robustness;
- passes targeted strategy reversals and exact-toy agreement;
- meets its live latency/memory budget;
- remains stable across seed blocks and opponent styles;
- exposes honest method and uncertainty metadata.

Otherwise it remains implemented as an experimental/offline option or is
removed from the production configuration.
