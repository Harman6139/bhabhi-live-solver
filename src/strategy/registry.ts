import { z } from "zod";

export const MOTIF_IDS = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
  "M08",
  "M09",
  "M10",
  "M11",
  "M12",
  "M13",
  "M14",
  "M15",
  "M16",
  "M17",
  "M18",
  "M19",
  "M20",
  "M21",
  "M22",
  "M23",
  "M24",
  "M25",
  "M26",
  "M27",
  "M28",
  "M29",
  "M30",
  "M31",
  "M32",
  "M33",
  "M34",
  "M35",
  "M36",
  "M37",
  "M38",
  "M39",
  "M40",
  "M41",
  "M42",
  "M43",
  "M44",
  "M45",
  "M46",
  "M47",
  "M48",
] as const;

export type MotifId = (typeof MOTIF_IDS)[number];
export type MotifClassification =
  "required-correctness" | "reported" | "hypothesis";
export type CoverageGrade = "direct" | "prerequisite" | "absent";

const nonEmptyStringSchema = z.string().trim().min(1);
const executableEvidencePathSchema = z
  .string()
  .regex(/^tests\/.+\.test\.[cm]?[jt]sx?$/u);

export const motifRegistryEntrySchema = z
  .object({
    id: z.enum(MOTIF_IDS),
    description: nonEmptyStringSchema,
    exampleState: nonEmptyStringSchema,
    classification: z.enum(["required-correctness", "reported", "hypothesis"]),
    proposedExperimentId: z
      .string()
      .regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u),
    requiredCapability: nonEmptyStringSchema,
    boundary: nonEmptyStringSchema,
    currentCoverage: z.enum(["direct", "prerequisite", "absent"]),
    existingExecutableEvidencePaths: z.array(executableEvidencePathSchema),
    coverageNote: nonEmptyStringSchema,
  })
  .strict();

export type MotifRegistryEntry = z.infer<typeof motifRegistryEntrySchema>;

type EntryInput = MotifRegistryEntry;

function motif(entry: EntryInput): EntryInput {
  return entry;
}

/**
 * Machine-readable transcription of docs/strategy-taxonomy.md M01-M48.
 *
 * Coverage is deliberately conservative. A path records an executable test
 * that exists today; it is not a claim that an experiment was run or that an
 * experimental motif was retained.
 */
export const MOTIF_REGISTRY = [
  motif({
    id: "M01",
    description:
      "Shedding the final card of a suit creates future thulla option value.",
    exampleState: "User can empty Clubs now or retain one low Club.",
    classification: "hypothesis",
    proposedExperimentId: "motif:last-suit-option",
    requiredCapability: "Suit shape, downstream terminal rollout.",
    boundary:
      "Keeping the suit may be safer when the user would otherwise thulla into their own pickup.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Terminal rollout and singleton-void fixtures exist, but the paired motif experiment has not run.",
  }),
  motif({
    id: "M02",
    description:
      "A high lead can be a liability into a known later void because it remains pickup-high.",
    exampleState: "User leads Q♦ before a known-void last seat.",
    classification: "required-correctness",
    proposedExperimentId: "trap:diamond-q-user-pickup",
    requiredCapability: "Seat order, first-thulla termination, pickup owner.",
    boundary: "A still-higher intervening opponent can take the pickup.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/diamond-trap.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Rule and terminal-search fixtures directly make the user pick up after the Q♦ lead.",
  }),
  motif({
    id: "M03",
    description:
      "A low lead can transfer the same pickup to an intervening opponent.",
    exampleState: "User 4♦, P2 J♦, P3 void ♦.",
    classification: "required-correctness",
    proposedExperimentId: "trap:diamond-4-p2-pickup",
    requiredCapability: "Exact trick resolution and causal trace.",
    boundary:
      "Reverses if P2 cannot legally play/overtake or seat order changes.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/diamond-trap.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Rule and terminal-search fixtures directly make P2 pick up after the 4♦ lead.",
  }),
  motif({
    id: "M04",
    description:
      "High cards are assets in clean tricks when gaining power improves the next lead.",
    exampleState: "No opponent likely void; user can win with K♥.",
    classification: "hypothesis",
    proposedExperimentId: "motif:high-card-clean-power",
    requiredCapability: "Dynamic rank value, power rollout.",
    boundary:
      "Power can be harmful near zero cards or against bad suit structure.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Dynamic-rank and power diagnostics exist, but this paired clean-trick claim is unrun.",
  }),
  motif({
    id: "M05",
    description: "Low cards can preserve the ability to duck power.",
    exampleState: "Following 4♣ or Q♣ under K♣.",
    classification: "hypothesis",
    proposedExperimentId: "motif:duck-power-low",
    requiredCapability: "Legal alternatives and power diagnostics.",
    boundary:
      "If a later thulla makes the user highest anyway, rank choice may not matter.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Rank-sensitive terminal fixtures exist, but the proposed duck-power experiment is unrun.",
  }),
  motif({
    id: "M06",
    description:
      "Seat position changes low-card trap value because later players are skipped after thulla.",
    exampleState: "Known void acts second versus third.",
    classification: "required-correctness",
    proposedExperimentId: "motif:seat-sensitive-thulla",
    requiredCapability: "Active seat order and early termination.",
    boundary: "Opening trick never terminates early.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/diamond-trap.test.ts",
      "tests/rules/normal-trick.test.ts",
    ],
    coverageNote:
      "Direction and first-thulla fixtures directly verify skipped later seats.",
  }),
  motif({
    id: "M07",
    description: "A thulla actively sheds a chosen off-suit card.",
    exampleState: "Void Hearts player discards A♣.",
    classification: "hypothesis",
    proposedExperimentId: "motif:thulla-as-shedding",
    requiredCapability: "Legal thulla selection and terminal rollout.",
    boundary:
      "Discarding A♣ may strengthen the pickup holder's hand or lose future control.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: [
      "tests/rules/normal-trick.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Legal off-suit play and terminal rollout exist; strategic benefit is untested.",
  }),
  motif({
    id: "M08",
    description: "A thulla denies later seats a turn.",
    exampleState: "P2 thullas before user's seat.",
    classification: "required-correctness",
    proposedExperimentId: "motif:thulla-turn-denial",
    requiredCapability: "Skipped-seat event trace.",
    boundary: "No denial on the opening trick.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/rules/normal-trick.test.ts"],
    coverageNote:
      "The normal-trick suite directly verifies first-thulla termination and skipped seats.",
  }),
  motif({
    id: "M09",
    description:
      "A thulla manipulates power by fixing the highest led-suit owner early.",
    exampleState: "Lead 6♥, P2 9♥, P3 thullas.",
    classification: "required-correctness",
    proposedExperimentId: "motif:thulla-power-transfer",
    requiredCapability: "Pickup and power identity.",
    boundary: "Another earlier led-suit card may already be higher.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/normal-trick.test.ts",
      "tests/rules/diamond-trap.test.ts",
    ],
    coverageNote:
      "Rule fixtures directly bind pickup and power to the highest prior lead-suit card.",
  }),
  motif({
    id: "M10",
    description:
      "Taking a pickup can restore a suit and erase a current void without erasing the historical fact.",
    exampleState: "P2 was ♥-void, then visibly picks up 7♥.",
    classification: "required-correctness",
    proposedExperimentId: "inference:temporal-void-restored",
    requiredCapability: "Temporal ownership and known pickup tracking.",
    boundary: "The old void remains valid at its original timestamp.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/inference/hard-evidence.test.ts"],
    coverageNote:
      "Hard-inference fixtures directly preserve the timed void while restoring visible cards.",
  }),
  motif({
    id: "M11",
    description:
      "Intentionally transferring power can improve terminal survival.",
    exampleState: "User follows low so P2 leads into P3's void.",
    classification: "hypothesis",
    proposedExperimentId: "motif:intentional-power-transfer",
    requiredCapability: "Multi-step search and separate actors.",
    boundary: "Transfer is bad if P2's lead traps the user.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Multi-step terminal rollout and self-interested actors exist; the paired transfer experiment is unrun.",
  }),
  motif({
    id: "M12",
    description:
      "Retaining power with zero cards can be harmful under waste-draw rules.",
    exampleState: "User's last card is trick-high.",
    classification: "required-correctness",
    proposedExperimentId: "variant:zero-power-profile-reversal",
    requiredCapability: "Zero-card variant and chance draw.",
    boundary: "Immediate-escape profile reverses the result.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/escape-and-variants.test.ts",
      "tests/search/variants-crn.test.ts",
    ],
    coverageNote:
      "Rules and search fixtures directly exercise waste draw and immediate-escape alternatives.",
  }),
  motif({
    id: "M13",
    description:
      "The identity of the first opponent to escape changes heads-up value.",
    exampleState: "Same counts, but P2 versus P3 remains.",
    classification: "required-correctness",
    proposedExperimentId: "search:escape-identity-terminal",
    requiredCapability: "Escape identity and heads-up transition.",
    boundary: "Models/hands symmetric under a constructed state.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "The terminal-search suite directly preserves first escape and heads-up opponent identity.",
  }),
  motif({
    id: "M14",
    description: "Fewer cards is not always a better terminal state.",
    exampleState:
      "Three awkward high cards versus four complementary low cards.",
    classification: "hypothesis",
    proposedExperimentId: "counterexample:card-count-fallacy",
    requiredCapability: "Terminal solving beyond count heuristic.",
    boundary: "In some exact states dominance by subset/card count may hold.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Search optimizes terminal Bhabhi risk, but the proposed card-count counterexample has not been mined.",
  }),
  motif({
    id: "M15",
    description:
      "Sacrificing immediate shedding can improve final hand structure.",
    exampleState: "Lead from a longer suit instead of singleton.",
    classification: "hypothesis",
    proposedExperimentId: "motif:sacrifice-shed-for-structure",
    requiredCapability: "Long-horizon terminal rollout.",
    boundary:
      "Singleton shedding wins when it creates a safe guaranteed escape.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Terminal rollout exists, but no paired structure-versus-shedding experiment has run.",
  }),
  motif({
    id: "M16",
    description:
      "Shortest-suit depletion is useful when the resulting thulla is safe.",
    exampleState: "Two Clubs, six Hearts; shed Clubs.",
    classification: "hypothesis",
    proposedExperimentId: "motif:shortest-suit-context",
    requiredCapability: "Suit-length features and future pickup estimate.",
    boundary: "Known void downstream may make Club leads dangerous.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: [
      "tests/simulator/policies.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Shortest-suit policy and pickup diagnostics exist; contextual benefit remains untested.",
  }),
  motif({
    id: "M17",
    description: "Preserving a suit can block an unwanted thulla/pickup cycle.",
    exampleState: "One low Diamond retained to follow safely.",
    classification: "hypothesis",
    proposedExperimentId: "motif:preserve-suit-block",
    requiredCapability: "Cycle-aware rollout.",
    boundary:
      "If following makes the user pickup-high, becoming void is better.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Terminal rollout is available, but no cycle-aware paired evidence exists.",
  }),
  motif({
    id: "M18",
    description:
      "Leading into an immediate next-seat void often forces the leader to pick up.",
    exampleState: "User leads 5♠; P2 is void and thullas.",
    classification: "required-correctness",
    proposedExperimentId: "motif:lead-into-next-void",
    requiredCapability: "Seat order and pickup.",
    boundary:
      "Another led-suit player before the void can overtake only if the void is later.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/normal-trick.test.ts",
      "tests/rules/diamond-trap.test.ts",
      "tests/strategy/required-motifs.test.ts",
    ],
    coverageNote:
      "The focused strategy fixture directly proves immediate-next-seat thulla termination, skipped later seats, and leader pickup.",
  }),
  motif({
    id: "M19",
    description:
      "Leading into a last-seat void can be beneficial when an intervening card overtakes.",
    exampleState: "Mandatory Diamond trap.",
    classification: "required-correctness",
    proposedExperimentId: "trap:correlated-seat-event",
    requiredCapability: "Correlated overtake/void query.",
    boundary: "User remains high or intervening player chooses lower.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/diamond-trap.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "The mandatory Diamond trap directly covers the correlated overtake and later void.",
  }),
  motif({
    id: "M20",
    description:
      "A merely inferred void should produce sensitivity, not a categorical rule.",
    exampleState: "P3 is 0.7 likely ♥-void.",
    classification: "required-correctness",
    proposedExperimentId: "belief:soft-vs-hard-void",
    requiredCapability: "Weighted worlds, intervals, sensitivity.",
    boundary: "Hard chronological void is known, not inferred.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/strategy/required-motifs.test.ts"],
    coverageNote:
      "The weighted-world query directly distinguishes a soft 0.7 void estimate from categorical chronological hard evidence.",
  }),
  motif({
    id: "M21",
    description: "Exact picked-up high cards can change safe lead selection.",
    exampleState: "P2 visibly owns A♥ after pickup.",
    classification: "required-correctness",
    proposedExperimentId: "inference:pickup-known-until-played",
    requiredCapability: "Exact known ownership in legal/action model.",
    boundary: "Card may since have been observed leaving.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/hard-evidence.test.ts",
      "tests/integration/manual-tracker.test.tsx",
      "tests/strategy/required-motifs.test.ts",
    ],
    coverageNote:
      "Chronological pickup ownership and departure are tested together with a focused exact-card safe-lead reversal.",
  }),
  motif({
    id: "M22",
    description:
      "The same player's historical void and current suit ownership can coexist.",
    exampleState: "Void at event 12; pickup at event 18.",
    classification: "required-correctness",
    proposedExperimentId: "inference:void-pickup-timeline",
    requiredCapability: "Temporal evidence queries.",
    boundary:
      "Without an intervening acquisition, current ownership is impossible.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/inference/hard-evidence.test.ts"],
    coverageNote:
      "Temporal inference directly tests restoration and rejects ownership without acquisition.",
  }),
  motif({
    id: "M23",
    description:
      "A forced low-card play carries little or no behavioral evidence.",
    exampleState: "Opponent has exactly one legal Heart.",
    classification: "required-correctness",
    proposedExperimentId: "behavior:forced-action-likelihood",
    requiredCapability: "Alternative-aware likelihood.",
    boundary: "Hard evidence from the card and count still applies.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-models.test.ts",
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "Forced singleton alternatives are exactly neutral in both model and chronological belief tests.",
  }),
  motif({
    id: "M24",
    description:
      "A discretionary low choice can support low-preservation/high-shedding models differently.",
    exampleState: "Opponent chooses 3♥ from 3♥/K♥.",
    classification: "hypothesis",
    proposedExperimentId: "behavior:discretionary-low-update",
    requiredCapability: "Per-model softmax over legal alternatives.",
    boundary: "Evidence should be tempered and policy-context dependent.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-models.test.ts",
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "Legal-alternative softmax distributions and discretionary low/high posterior updates are directly tested; the strategic outcome hypothesis remains unrun.",
  }),
  motif({
    id: "M25",
    description:
      "Repeated early high-card shedding may update one opponent's model.",
    exampleState: "P2 repeatedly chooses high among legal ranks.",
    classification: "hypothesis",
    proposedExperimentId: "calibration:high-shedder-gradual",
    requiredCapability: "Separate sequential model posterior.",
    boundary: "One play or forced highs must not classify the player.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-models.test.ts",
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "Repeated discretionary high choices update the acting opponent gradually; the terminal-strategy hypothesis remains unrun.",
  }),
  motif({
    id: "M26",
    description:
      "One noisy legal action must not collapse world or model mass.",
    exampleState: "High-shedder model observes an odd low play.",
    classification: "required-correctness",
    proposedExperimentId: "behavior:single-noise-no-collapse",
    requiredCapability: "Error mixture, floor, ESS diagnostics.",
    boundary: "Impossible actions remain zero-likelihood.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-models.test.ts",
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "Positive lapse support, Bayes-factor caps, normalization, and ESS diagnostics directly prevent one-action collapse.",
  }),
  motif({
    id: "M27",
    description:
      "Player 2 and Player 3 may require different policy posteriors.",
    exampleState: "P2 high-sheds; P3 avoids power.",
    classification: "required-correctness",
    proposedExperimentId: "behavior:separate-opponent-models",
    requiredCapability: "Per-player parameters/posteriors.",
    boundary: "Symmetric evidence may leave posteriors equal.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "Chronological behavioral replay maintains and directly tests separate P2 and P3 posterior vectors.",
  }),
  motif({
    id: "M28",
    description:
      "Joint trap probability cannot be obtained by multiplying unrelated marginals.",
    exampleState: "P2 overtakes and P3 is void are correlated by allocation.",
    classification: "required-correctness",
    proposedExperimentId: "belief:correlated-probabilistic-trap",
    requiredCapability: "World-level joint/conditional query.",
    boundary: "Multiplication is valid only under demonstrated independence.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/belief.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Exact joint queries and whole-correlated-world search are directly tested.",
  }),
  motif({
    id: "M29",
    description: "Common random numbers stabilize action comparisons.",
    exampleState: "Compare 4♦ and Q♦ on identical worlds/rollout seeds.",
    classification: "hypothesis",
    proposedExperimentId: "search:crn-variance-ablation",
    requiredCapability: "Paired sampling and deterministic RNG streams.",
    boundary: "Poor coupling can increase variance for unrelated branches.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/variants-crn.test.ts"],
    coverageNote:
      "Semantic CRN tape equality is tested, but the variance ablation has not run.",
  }),
  motif({
    id: "M30",
    description: "Waste-draw chance distribution changes zero-power value.",
    exampleState: "Several eligible waste cards lead to different outcomes.",
    classification: "required-correctness",
    proposedExperimentId: "search:waste-draw-chance",
    requiredCapability: "Exact chance nodes and eligible waste set.",
    boundary: "Deterministic immediate-escape variant has no draw.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/escape-and-variants.test.ts",
      "tests/search/variants-crn.test.ts",
    ],
    coverageNote:
      "Rules and terminal search directly test the eligible waste set and reproducible draw.",
  }),
  motif({
    id: "M31",
    description:
      "Heads-up lower follow versus higher follow has asymmetric shootout consequences.",
    exampleState: "Empty leader draws/plays; opponent follows lower or higher.",
    classification: "required-correctness",
    proposedExperimentId: "endgame:shootout-branches",
    requiredCapability: "Two-player rules and terminal identity.",
    boundary: "Simplified shootout variant terminates differently.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/rules/heads-up.test.ts"],
    coverageNote:
      "The heads-up suite directly covers higher, lower, off-suit, and simplified branches.",
  }),
  motif({
    id: "M32",
    description: "Leading a last card is not automatically escape.",
    exampleState: "User leads last 8♣ and retains power.",
    classification: "required-correctness",
    proposedExperimentId: "endgame:last-lead-power-risk",
    requiredCapability: "Zero-card-with-power handling.",
    boundary: "If opponent overtakes, user safely escapes.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/heads-up.test.ts",
      "tests/rules/escape-and-variants.test.ts",
    ],
    coverageNote:
      "Heads-up and zero-power fixtures directly distinguish retained power from safe escape.",
  }),
  motif({
    id: "M33",
    description:
      "Taking a neighbor's hand can add useful low cards and complementary voids.",
    exampleState:
      "Optional take rule enabled, neighbor lacks user's long suit.",
    classification: "reported",
    proposedExperimentId: "variant:take-hand-benefit-search",
    requiredCapability: "Typed take event and terminal search.",
    boundary: "More cards and restored suits can make the take harmful.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: [
      "tests/rules/escape-and-variants.test.ts",
      "tests/search/variants-crn.test.ts",
    ],
    coverageNote:
      "Typed take transfer and terminal evaluation exist, but no retained-benefit claim has run.",
  }),
  motif({
    id: "M34",
    description:
      "Taking another hand can be dominated despite apparent card quality.",
    exampleState: "Neighbor has many cards or dangerous highs.",
    classification: "hypothesis",
    proposedExperimentId: "variant:take-hand-harm",
    requiredCapability: "Take action evaluated on terminal risk.",
    boundary: "Exact complementary structure may outweigh count.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/variants-crn.test.ts"],
    coverageNote:
      "Root take actions reach terminal utility, but the paired harm experiment is unrun.",
  }),
  motif({
    id: "M35",
    description:
      "Highest-off-suit opening restriction changes legal input and inference.",
    exampleState: "Void Spades player holds A♥ and 2♦.",
    classification: "required-correctness",
    proposedExperimentId: "variant:opening-off-suit",
    requiredCapability: "Opening variant and legal alternatives.",
    boundary: "Default `any-off-suit` permits both.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/opening.test.ts",
      "tests/inference/hard-evidence.test.ts",
    ],
    coverageNote:
      "Opening legality and chronological highest-card constraints are directly tested.",
  }),
  motif({
    id: "M36",
    description:
      "Direction reversal changes order, trap ownership, and take target.",
    exampleState: "Clockwise trap rerun anticlockwise.",
    classification: "required-correctness",
    proposedExperimentId: "variant:direction-reversal",
    requiredCapability: "Direction-aware active order everywhere.",
    boundary: "Symmetric hands/state can hide the difference.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/rules/diamond-trap.test.ts",
      "tests/rules/escape-and-variants.test.ts",
    ],
    coverageNote:
      "Reversed trap order and direction-aware take targeting are directly tested.",
  }),
  motif({
    id: "M37",
    description:
      "Strange but legal play should retain nonzero behavioral likelihood.",
    exampleState: "Skilled model plays an apparently poor low card.",
    classification: "required-correctness",
    proposedExperimentId: "behavior:legal-move-positive-floor",
    requiredCapability: "Error mixture and model averaging.",
    boundary: "A rule-illegal play is rejected, not softened.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-models.test.ts",
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "Every legal action retains positive model likelihood and positive posterior support; illegal actions still fail hard.",
  }),
  motif({
    id: "M38",
    description:
      "Information value must arise through later decisions, not a static bonus.",
    exampleState:
      "Two moves have equal immediate outcome but reveal different opponent response.",
    classification: "hypothesis",
    proposedExperimentId: "search:information-value-counterfactual",
    requiredCapability: "Belief update inside downstream search.",
    boundary:
      "If no later user decision can use the observation, value is zero.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-belief.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Chronological belief updating and downstream search exist separately; belief updates inside downstream search remain Phase 7 work.",
  }),
  motif({
    id: "M39",
    description:
      "Exact enumeration should replace sampling in sufficiently small beliefs/endgames.",
    exampleState: "Two unresolved cards and short hands.",
    classification: "required-correctness",
    proposedExperimentId: "exact:enumeration-threshold-agreement",
    requiredCapability: "Feasible-world count and memoized DP.",
    boundary: "Large branching or model mixtures may exceed exact budget.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/search/exact-endgame.test.ts",
      "tests/search/exact-endgame-oracle.test.ts",
      "tests/search/exact-information-state.test.ts",
      "tests/search/exact-endgame-dispatch.test.ts",
      "tests/search/research-dispatch.test.ts",
    ],
    coverageNote:
      "Bounded exact information-state search, independent brute-force agreement, strategy-fusion prevention, typed refusal boundaries, cycle detection, and exact-to-approximate research dispatch are directly tested.",
  }),
  motif({
    id: "M40",
    description:
      "A fragile best action should warn when opponent-model assumptions change it.",
    exampleState: "High-shedder mixture favors A; random mixture favors B.",
    classification: "required-correctness",
    proposedExperimentId: "search:model-sensitivity-label",
    requiredCapability: "Model ensemble sensitivity.",
    boundary: "Stable dominance needs no warning.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/search/model-sensitivity.test.ts",
      "tests/search/exact-model-sensitivity.test.ts",
    ],
    coverageNote:
      "Stable and fragile recommendations, tie and zero-weight handling, advisory robust diagnostics, and solver-backed P2/P3 model-cell reversals are directly tested.",
  }),
  motif({
    id: "M41",
    description:
      "Overtaking probability is conditional on the same allocation that determines later voids.",
    exampleState: "P2 high ♦ ownership competes with P3 ♦ void evidence.",
    classification: "required-correctness",
    proposedExperimentId: "belief:overtake-void-joint",
    requiredCapability: "Correlated world representation.",
    boundary: "A toy construction may intentionally factorize.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/belief.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Joint allocation queries and whole-world terminal scenarios are directly tested.",
  }),
  motif({
    id: "M42",
    description: "Pickup composition can matter more than pickup size.",
    exampleState:
      "Picking up three complementary lows versus two isolated highs.",
    classification: "hypothesis",
    proposedExperimentId: "motif:pickup-composition-vs-size",
    requiredCapability: "Exact card-composition terminal rollout.",
    boundary: "In a dominated exact state, size alone may decide.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: [
      "tests/rules/exact-hand-transition.test.ts",
      "tests/search/solver-strategy.test.ts",
    ],
    coverageNote:
      "Exact pickup composition survives rollout, but the paired comparison is unrun.",
  }),
  motif({
    id: "M43",
    description:
      "Repeated power cycles can trap a player despite low card count.",
    exampleState: "Player continually wins clean tricks and must lead.",
    classification: "hypothesis",
    proposedExperimentId: "counterexample:power-cycle",
    requiredCapability: "Long-horizon cycle detection.",
    boundary: "A safe higher response can break the cycle.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Long terminal rollouts exist, but cycle mining/detection evidence does not.",
  }),
  motif({
    id: "M44",
    description:
      "Opponents are individually self-interested, so their preferred moves can conflict.",
    exampleState: "P2 prefers P3 pickup; P3 prefers user pickup.",
    classification: "required-correctness",
    proposedExperimentId: "search:noncolluding-multiplayer",
    requiredCapability: "Vector utilities and actor-specific policies.",
    boundary: "Constructed identical utilities can align them.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "The search suite directly rejects an anti-user collusion oracle in favor of actor policies.",
  }),
  motif({
    id: "M45",
    description:
      "Escape-order value can be nonmonotonic: helping a weak opponent escape may create a worse heads-up rival.",
    exampleState: "User can force P2 or P3 out first.",
    classification: "hypothesis",
    proposedExperimentId: "motif:escape-order-reversal",
    requiredCapability: "Escape identity, model/hand-aware terminal search.",
    boundary: "Remaining opponents equivalent.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/search/solver-strategy.test.ts"],
    coverageNote:
      "Escape identity is preserved, but the nonmonotonic reversal experiment is unrun.",
  }),
  motif({
    id: "M46",
    description:
      "Known possession of an overtake card changes the causal confidence, not just a marginal.",
    exampleState: "Visible pickup gives P2 J♦ in trap.",
    classification: "required-correctness",
    proposedExperimentId: "trap:known-jack-diamond",
    requiredCapability: "Known-card world filtering.",
    boundary: "The J♦ may already have been played.",
    currentCoverage: "direct",
    existingExecutableEvidencePaths: [
      "tests/inference/hard-evidence.test.ts",
      "tests/rules/diamond-trap.test.ts",
      "tests/strategy/required-motifs.test.ts",
    ],
    coverageNote:
      "A focused correlated-world fixture directly compares known J-diamond possession with unresolved placement and verifies the changed trap probability.",
  }),
  motif({
    id: "M47",
    description:
      "Probability of exactly one card in a suit predicts near-term depletion differently from expected suit length.",
    exampleState: "Same mean length, different distributions.",
    classification: "hypothesis",
    proposedExperimentId: "belief:suit-length-distribution",
    requiredCapability: "World-derived distributional queries.",
    boundary: "Degenerate belief makes both equivalent.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: ["tests/inference/belief.test.ts"],
    coverageNote:
      "Exact suit-length distributions exist, but the equal-mean depletion comparison is unrun.",
  }),
  motif({
    id: "M48",
    description:
      "Robust action can beat the learned-expectation winner when model uncertainty is material.",
    exampleState:
      "Action A narrowly best for fitted model; B stable across ensemble.",
    classification: "hypothesis",
    proposedExperimentId: "search:robust-ensemble-ablation",
    requiredCapability: "Expected and robust/sensitivity diagnostics.",
    boundary:
      "Production primary objective remains expected terminal risk unless preregistered eligibility justifies robust selection.",
    currentCoverage: "prerequisite",
    existingExecutableEvidencePaths: [
      "tests/inference/behavior-models.test.ts",
      "tests/inference/behavior-belief.test.ts",
    ],
    coverageNote:
      "A learned per-opponent model mixture exists, but robust action selection and its preregistered terminal ablation remain Phase 7 work.",
  }),
] as const satisfies readonly MotifRegistryEntry[];

export class StrategyRegistryError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid strategy registry:\n${issues.join("\n")}`);
    this.name = "StrategyRegistryError";
    this.issues = [...issues];
  }
}

export function validateMotifRegistry(
  value: unknown,
): readonly MotifRegistryEntry[] {
  const parsed = z.array(motifRegistryEntrySchema).safeParse(value);
  if (!parsed.success) {
    throw new StrategyRegistryError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "registry"}: ${issue.message}`,
      ),
    );
  }

  const issues: string[] = [];
  const ids = new Set<MotifId>();
  const experimentIds = new Set<string>();
  for (const entry of parsed.data) {
    if (ids.has(entry.id)) {
      issues.push(`duplicate motif ID ${entry.id}`);
    }
    ids.add(entry.id);
    if (experimentIds.has(entry.proposedExperimentId)) {
      issues.push(`duplicate experiment ID ${entry.proposedExperimentId}`);
    }
    experimentIds.add(entry.proposedExperimentId);

    if (
      entry.currentCoverage === "absent" &&
      entry.existingExecutableEvidencePaths.length !== 0
    ) {
      issues.push(`${entry.id} absent coverage must not cite executable paths`);
    }
    if (
      entry.currentCoverage !== "absent" &&
      entry.existingExecutableEvidencePaths.length === 0
    ) {
      issues.push(
        `${entry.id} ${entry.currentCoverage} coverage requires a path`,
      );
    }
  }

  if (parsed.data.length !== MOTIF_IDS.length) {
    issues.push(
      `registry has ${parsed.data.length.toString()} entries; expected ${MOTIF_IDS.length.toString()}`,
    );
  }
  for (const id of MOTIF_IDS) {
    if (!ids.has(id)) {
      issues.push(`missing motif ID ${id}`);
    }
  }
  if (issues.length > 0) {
    throw new StrategyRegistryError(issues);
  }
  return parsed.data;
}

export function motifById(id: MotifId): MotifRegistryEntry {
  const entry = MOTIF_REGISTRY.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new StrategyRegistryError([`missing canonical motif ID ${id}`]);
  }
  return entry;
}
