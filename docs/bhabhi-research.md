# Bhabhi / Getaway Research

Status: Phase 0 source review, 2026-07-27.

## Scope and evidence policy

This document separates four evidence classes:

1. **Documented rule** — stated by an identifiable rules reference or
   implementation.
2. **Commonly reported strategy** — advice repeated by rules/community sources,
   but not experimentally validated here.
3. **Hypothesis** — plausible play or modeling idea awaiting a reproducible test.
4. **Experimental** — supported by this project's stored simulator or benchmark
   evidence.

No governing body or canonical published rulebook was found. The sources are
descriptive accounts of a household game, so agreement across independent
descriptions is useful evidence but does not make a variant universal.
`GOAL.md` is authoritative for this product's canonical profile.

## Names, origin, and terminology

- Pagat documents the game in Punjab (India and Pakistan) and Bangladesh, calls
  it **Getaway**, and notes the names **Bhabhi Thulla**, **thulla**, and
  **tochoo**. It describes thulla as a slang term applied to the off-suit card
  that interrupts a trick. This is a documented terminology claim, not an
  assertion that every household uses the same word.
- Pagat also explains that “Bhabhi” is used mockingly for the loser and can be
  culturally offensive. The product should lead with **Getaway** in general UI
  copy while retaining “Bhabhi” as a searchable game alias and the requested
  terminal-risk term.
- A related Kerala game called **Donkey** adds a trump mechanism and is not the
  canonical game implemented here.

Primary rules reference:
[John McLeod, “Getaway” at Pagat](https://www.pagat.com/inflation/getaway.html).

## Documented core-rule agreement

The following appears consistently in the stronger rules descriptions:

| Topic        | Source-derived rule                                                           | Evidence class  |
| ------------ | ----------------------------------------------------------------------------- | --------------- |
| Deck         | Standard 52-card pack, no jokers; rank A high through 2 low                   | Documented rule |
| Deal         | Deal the whole pack as evenly as possible                                     | Documented rule |
| Opening      | Holder of A♠ opens with A♠                                                    | Documented rule |
| Follow suit  | A player holding the led suit must play that suit                             | Documented rule |
| Rank choice  | Any rank in the required suit is legal; beating is not required               | Documented rule |
| Off-suit     | A void player may play another suit (thulla/tochoo)                           | Documented rule |
| Normal trick | First off-suit play ends the trick and skips later seats                      | Documented rule |
| Pickup       | Highest card already played in the led suit takes the played pile             | Documented rule |
| Clean trick  | If all follow, cards go to waste                                              | Documented rule |
| Power        | Highest led-suit player leads next, whether the trick was wasted or picked up | Documented rule |
| Escape       | Players who legally empty their hands leave; last player with cards loses     | Documented rule |

Corroborating references:

- [BoardGameGeek community wiki, “Bhabhi”](https://boardgamegeek.com/wiki/page/thing%3A61953)
  gives a concise independent description of immediate off-suit termination and
  highest-lead-suit pickup.
- [Zymbiotic Technologies, “Bhabhi Card Game Rules”](https://www.zymbiotic.com/bhabhi/rules/)
  independently describes A♠ opening, clockwise follow-suit play, immediate
  tochoo termination, highest-led-suit pickup, power, waste, and the last-player
  loss.
- [Sarbsukh, “BHABHI CARD GAME”](https://www.sarbsukh.com/bhabhi.html)
  describes a deployed app whose rules include first-thulla termination,
  skipped later seats, waste draw when empty with power, and a configurable
  next/previous-player take action.
- [Denexa Games, “Getaway”](https://www.denexa.com/blog/getaway/) gives a
  detailed two-player shootout description and a zero-card-with-power draw
  procedure.
- [CardzMania, “Bhabhi” rules/options](https://www.cardzmania.com/Bhabhi)
  documents first-thulla termination, pickup/waste/power, optional take-card and
  draw-card settings, and a simplified head-to-head termination rule.

## Opening trick

Pagat explicitly states that every active player contributes to the first trick:
players with Spades follow; a player with no Spades may play any card; and the
entire opening trick goes to waste even when an off-suit card appears. The A♠
holder then leads again. Zymbiotic independently says the opening tochoo penalty
is waived. A [first-person Punjabi community account from
2010](https://moonrosejatti.blogspot.com/2010/04/how-to-play-bhabhi.html)
corroborates that the opening completes and is wasted, but requires a void player
to shed their highest off-suit card. This is direct evidence for the named
`highest` variant, not for changing the canonical `any` default.

Product consequence:

- the opening phase is not implemented by reusing normal first-thulla
  termination;
- an opening off-suit play is hard chronological evidence that the actor had no
  Spades immediately before that play;
- the alternative `highest-off-suit` restriction is a typed variant, not part of
  the default.

Evidence class: **documented rule**.

## Canonical product profile

Where `GOAL.md` fixes behavior, it overrides source conflicts. Where it requires a
deterministic choice but does not name one, Phase 0 adopts the following
source-backed defaults:

| Setting               | Canonical value                 | Basis                                                                      |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Active players        | exactly 3                       | product scope                                                              |
| Direction             | clockwise                       | Pagat and Zymbiotic main descriptions                                      |
| Deal counts           | a permutation of 18, 17, 17     | whole 52-card pack dealt as evenly as possible                             |
| Take another hand     | disabled                        | conservative local-tracker default; enabled modes remain explicit variants |
| Zero cards with power | draw from waste and lead        | Pagat/Zymbiotic/CardzMania documented main or shootout behavior            |
| Opening off-suit      | any off-suit card               | Pagat main description                                                     |
| Normal first thulla   | ends trick immediately          | `GOAL.md` and all detailed references                                      |
| Heads-up              | Pagat-style shootout/waste draw | most explicit complete documented procedure                                |

Disabling take-hand by default is a product choice, not a claim about universal
tradition. It prevents an optional, strategically drastic rule from silently
changing a fresh game. Setup exposes the documented alternatives.

## Variant and uncertainty ledger

| Question                                      | Source evidence                                                                                                               | Product treatment                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Clockwise or anticlockwise?                   | Pagat uses clockwise and documents anticlockwise as a regional variant.                                                       | Typed direction; clockwise default.                                                                                         |
| Who may be taken?                             | Pagat says immediate left/next clockwise active player; Zymbiotic says player to the left; households may differ.             | Disabled, next-active, adjacent, or configured target semantics.                                                            |
| When may a hand be taken?                     | Pagat says before any trick; Zymbiotic says on the taker's turn.                                                              | Define exact event preconditions centrally; no permissive free-form mutation.                                               |
| Can a zero-card power holder escape?          | Pagat main rule draws from waste; it also lists immediate escape or draw-from-player variants. Denexa documents a waste draw. | Typed `waste-draw`, `immediate-escape`, and configured take/draw behavior.                                                  |
| What is excluded from a waste draw?           | Pagat excludes the just-completed trick before it enters waste.                                                               | Explicit eligible-card set in chance event.                                                                                 |
| Does opening off-suit terminate?              | Pagat and Zymbiotic say no.                                                                                                   | Never under default; variant semantics remain explicit.                                                                     |
| Which opening off-suit is legal?              | Pagat permits any card; some households reportedly require the highest off-suit.                                              | Typed `any` / `highest`.                                                                                                    |
| What happens with two players?                | Pagat/Denexa document a draw-based shootout; CardzMania documents an early-stop shortcut.                                     | Explicit profile; Pagat-style default plus separately named simplified alternative.                                         |
| Can direction or target skip escaped players? | Pagat targets the next player who still has cards.                                                                            | Always compute active order, never raw seat index alone.                                                                    |
| Multiple decks/ties?                          | Pagat suggests first-played wins duplicate ranks.                                                                             | Out of current 3-player single-deck scope; document as unsupported.                                                         |
| Penalties for mistaken physical play?         | Pagat describes pickup penalties.                                                                                             | Tracker rejects impossible input and supports correction; it does not adjudicate unobserved household penalties by default. |

No unresolved item blocks the canonical default because the profile above is
deterministic and every alternative is either typed or explicitly unsupported.

## Strategy statements found in sources

Only a small amount of written strategy was found:

- Pagat says taking the next player's hand can make sense when that player lacks
  suits held by the taker or supplies useful low cards.
- CardzMania repeats the idea that taking a neighbor's low cards or complementary
  void structure can improve a hand.
- The 2010 Punjabi community account explicitly calls remembering which player
  ran out of each suit the central trick for engineering a later Dhola. This is
  useful evidence for tracking chronological voids, while the exact tactical
  use remains state-dependent.
- The open-source `badar-92/card-game` README says CPU players use “suit
  avoidance” and advises a player who picked up a trick to avoid immediately
  leading the same suit. Its repository provides a playable Pygame
  implementation, but its strategy claims are not benchmark evidence:
  [repository](https://github.com/badar-92/card-game).

Evidence class: **commonly reported strategy**, not validated production policy.
The take-hand claims do not apply when the default take rule is disabled.

## Digital games, bots, and implementations

- [`badar-92/card-game`](https://github.com/badar-92/card-game) is a small public
  Python/Pygame implementation with 3–6 human/CPU players and strict follow-suit
  UI. Its README claims “smart” CPU play but publishes no evaluation showing
  terminal Bhabhi-rate strength, calibration, hidden-state inference, or an
  information firewall.
- [`himmatMahal/bhabhi`](https://github.com/himmatMahal/bhabhi) implements
  random, always-high, hand-coded, and small Q-learning agents for a simplified
  four-player game. Its README reports 5,000 games and headline win rates, but
  supplies no seed policy, raw artifacts, confidence intervals, terminal
  Bhabhi-risk objective, or clean holdout. Those numbers are recorded only as
  prior implementation claims and are never imported as project evidence.
- [`AqibChattha/Getaway-Card-Game`](https://github.com/AqibChattha/Getaway-Card-Game)
  is an MIT-licensed Java console implementation with Pagat-like documented
  rules and basic card/deck tests, but no hidden-state solver.
- [`iAmmarTahir/Thulla-Engine`](https://github.com/iAmmarTahir/Thulla-Engine)
  is a multiplayer state engine with opening/thulla logic but no public solver
  evaluation and no clearly declared reuse license.
- [Getaway: Bhabhi Card Game](https://www.bhabhicardgame.com/) advertises mobile
  bots, private rooms, multilingual UI, take-card and peek mechanics. These
  mechanics are product-specific and not evidence for canonical rules or solver
  quality.
- [CardzMania](https://www.cardzmania.com/Bhabhi) exposes several configurable
  rules, useful evidence that household variants materially affect digital play.

No located implementation demonstrates the full combination required by
`GOAL.md`: event-sourced live physical tracking, correlated hidden allocations,
separate uncertain opponent models, terminal-risk search, calibration, truth
firewall, and reproducible ablations.

## Initial hypotheses for experiments

These are **hypotheses**, not rules or production heuristics:

- becoming void can be valuable because a future thulla sheds a chosen card and
  ends the trick before later seats act;
- the best rank depends on who is likely to be highest when a known or likely
  void acts;
- a high lead can be harmful when it makes the user the forced pickup owner;
- transferring power can improve terminal survival despite shedding one fewer
  card immediately;
- the opponent who escapes first can dominate the value of the resulting
  heads-up matchup;
- behavioral choices can update hidden-card probabilities only after evaluating
  all legal alternatives in each correlated world;
- a tempered mixture of plausible policies may predict humans better than a
  single near-rational model;
- static “always high” or global card-value tables will reverse in strategically
  important states.

Each hypothesis is routed to a reproducible motif or experiment in
`docs/strategy-taxonomy.md`.

## Research limitations

- Household knowledge is oral and the web corpus is sparse.
- Several recent app pages are marketing material, not independent rules
  authorities or AI evaluations.
- Community repetition can reflect copied text rather than independent
  observation.
- No source justifies treating a surprising legal action as decisive evidence of
  a player's stable type.
- No source supplies a validated universal strategy suitable for hardcoding.
- Search-result pages calling themselves “official” conflict on basic mechanics;
  popularity or branding is not an authority signal.

Accordingly, exact observations and rule legality remain authoritative;
strategy and behavior claims must earn production status through stored
experiments.
