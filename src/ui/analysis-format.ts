import { formatCard } from "../domain/cards";
import type { Seat } from "../domain/seats";
import type {
  ProductionAnalysis,
  ProductionCandidate,
} from "../production/analysis-result";

export function formatWholePercent(value: number): string {
  return `${Math.round(value * 100).toString()}%`;
}

export function formatSignedPercentagePoints(value: number): string {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points.toString()} pp`;
}

export function formatAnalysisAction(
  action: ProductionCandidate["action"],
): string {
  return action.kind === "play-card"
    ? `Play ${formatCard(action.card)}`
    : `Take ${formatAnalysisSeat(action.target)}'s hand`;
}

export function formatAnalysisSeat(seat: Seat): string {
  if (seat === "user") {
    return "you";
  }
  return seat === "p2" ? "Player 2" : "Player 3";
}

function formatPossessiveSeat(seat: Seat): string {
  return seat === "user" ? "your" : `${formatAnalysisSeat(seat)}'s`;
}

export function formatCandidateInterval(
  candidate: ProductionCandidate,
): string | null {
  if (candidate.interval === null) {
    return null;
  }
  return `${formatWholePercent(candidate.interval.lower)}–${formatWholePercent(
    candidate.interval.upper,
  )}`;
}

function resolutionSentence(
  resolution: Extract<
    ProductionAnalysis["explanation"],
    { readonly status: "available" }
  >["primaryMechanism"],
): string {
  const outcome = resolution.resolution;
  switch (outcome.type) {
    case "trick-picked-up":
      return `${formatAnalysisSeat(outcome.picker)} picks up ${outcome.cardCount.toString()} cards after ${formatPossessiveSeat(outcome.thullaBy)} thulla`;
    case "trick-wasted":
      return `${formatAnalysisSeat(outcome.power)} wins power and wastes ${outcome.cardCount.toString()} cards`;
    case "take-hand":
      return `you take ${formatAnalysisSeat(outcome.target)}'s ${outcome.cardCount.toString()}-card hand`;
    case "game-completed":
      return `${formatAnalysisSeat(outcome.bhabhi)} is left as Bhabhi when the game completes`;
  }
}

export function causalExplanationText(analysis: ProductionAnalysis): string {
  const explanation = analysis.explanation;
  if (explanation.status === "unavailable") {
    return `Causal support is insufficient or tied: ${explanation.reason}. No additional story is inferred.`;
  }
  const mechanism = explanation.primaryMechanism;
  const riskDifference = explanation.terminalRiskDifference;
  const comparison =
    riskDifference <= 0
      ? `${Math.abs(Math.round(riskDifference * 100)).toString()} percentage points less estimated Bhabhi risk`
      : `${Math.round(riskDifference * 100).toString()} percentage points more estimated Bhabhi risk`;
  return `${formatAnalysisAction(analysis.recommendedAction)} has ${comparison} than ${explanation.comparatorActionKey}. The computed difference is that ${resolutionSentence(
    mechanism,
  )} (${formatWholePercent(
    mechanism.recommendedProbability,
  )} with the recommendation versus ${formatWholePercent(
    mechanism.comparatorProbability,
  )} with the comparator; ${formatSignedPercentagePoints(
    mechanism.probabilityDifference,
  )}).`;
}

export function formatDiagnosticNumber(
  value: ProductionAnalysis["diagnostics"]["belief"]["entropy"],
): string {
  return value.status === "available"
    ? value.value.toFixed(2)
    : `Unavailable — ${value.reason}`;
}
