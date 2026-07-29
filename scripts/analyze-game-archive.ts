import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { GameEvent } from "../src/events/game-events";
import {
  activeTimelineEvents,
  importGameArchive,
  replayTimeline,
  type GameTimeline,
} from "../src/events/timeline";
import {
  analyzeSelectedProductionRole,
  verifyProductionReleaseBundle,
} from "../src/production";
import type { ProductionAnalysis } from "../src/production/analysis-result";
import type { SolverBudgetId } from "../src/search";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

function actualActionKey(event: GameEvent): string | null {
  if (event.type === "card-played" && event.seat === "user") {
    return `play:${event.card}`;
  }
  if (event.type === "hand-taken" && event.actor === "user") {
    return `take:${event.target}`;
  }
  return null;
}

function actualActionLabel(event: GameEvent): string {
  if (event.type === "card-played") {
    return event.card;
  }
  if (event.type === "hand-taken") {
    return `take ${event.target}`;
  }
  return event.type;
}

function actionLabel(action: ProductionAnalysis["recommendedAction"]): string {
  return action.kind === "play-card" ? action.card : `take ${action.target}`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle] ?? 0;
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? upper) + upper) / 2
    : upper;
}

async function main(): Promise<void> {
  const archivePath = resolve(required("--archive"));
  const bundlePath = resolve(required("--bundle"));
  const outputPath = resolve(required("--output"));
  const budgetId = optional("--budget", "offline") as SolverBudgetId;

  const archiveBytes = await readFile(archivePath, "utf8");
  const timeline = importGameArchive(archiveBytes);
  const archiveDocument = JSON.parse(archiveBytes) as {
    readonly semanticHash: string;
    readonly documentHash: string;
  };
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as unknown;
  const release = await verifyProductionReleaseBundle(bundle, {
    allowEvaluationOnly: true,
  });
  const events = activeTimelineEvents(timeline);
  const decisions: Array<Record<string, unknown>> = [];

  for (let eventIndex = 1; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    if (event === undefined) {
      throw new Error(`Event ${eventIndex} is missing.`);
    }
    const actualKey = actualActionKey(event);
    if (actualKey === null) {
      continue;
    }
    const prefix: GameTimeline = {
      schemaVersion: 1,
      events: events.slice(0, eventIndex),
      cursor: eventIndex,
      orphanedEvents: [],
    };
    const before = replayTimeline(prefix).state;
    if (
      before.status !== "active" ||
      before.turn !== "user" ||
      before.pendingAction !== null
    ) {
      throw new Error(
        `Recorded user action ${eventIndex} is not an analyzable user turn.`,
      );
    }

    const analysis = analyzeSelectedProductionRole(
      { timeline: prefix, budgetId },
      release,
    );
    const actual = analysis.candidates.find(
      (candidate) => candidate.actionKey === actualKey,
    );
    const recommended = analysis.candidates.find(
      (candidate) => candidate.actionKey === analysis.recommendedActionKey,
    );
    if (actual === undefined || recommended === undefined) {
      throw new Error(
        `Action ${actualKey} is absent from solver candidates at ${eventIndex}.`,
      );
    }
    const forced = analysis.legalActions.length === 1;
    const tied = analysis.approximateTieActionKeys.includes(actualKey);
    const classification = forced
      ? "forced"
      : actualKey === analysis.recommendedActionKey
        ? "top"
        : tied
          ? "tied"
          : "suboptimal";
    const localRiskGap = Math.max(
      0,
      actual.userBhabhiRisk - recommended.userBhabhiRisk,
    );
    const decision = {
      ordinal: decisions.length + 1,
      eventIndex,
      actualAction: actualActionLabel(event),
      actualActionKey: actualKey,
      recommendedAction: actionLabel(analysis.recommendedAction),
      recommendedActionKey: analysis.recommendedActionKey,
      classification,
      forced,
      legalActionCount: analysis.legalActions.length,
      tiedBestActionKeys: analysis.approximateTieActionKeys,
      route: analysis.route.selectedMethod,
      quality: analysis.route.quality,
      exactOutcome: analysis.diagnostics.exact.outcome,
      exactRefusalCode: analysis.diagnostics.exact.refusalCode,
      actualUserBhabhiRisk: actual.userBhabhiRisk,
      recommendedUserBhabhiRisk: recommended.userBhabhiRisk,
      localRiskGap,
      actualInterval: actual.interval,
      recommendedInterval: recommended.interval,
      handBefore: before.userHand,
      handCountBefore: before.handCounts.user,
      countsBefore: before.handCounts,
      powerBefore: before.power,
      leadSuit: before.trick?.leadSuit ?? null,
      trickCardsBefore:
        before.trick?.plays.map((play) => ({
          seat: play.seat,
          card: play.card,
        })) ?? [],
      analysisHash: analysis.analysisHash,
      elapsedMs: analysis.telemetry.elapsedMs,
      deadlineExceeded: analysis.telemetry.deadlineExceeded,
      warnings: analysis.warnings,
    };
    decisions.push(decision);
    process.stdout.write(
      `${JSON.stringify({
        progress: `${decisions.length}`,
        eventIndex,
        actual: actualActionLabel(event),
        recommended: actionLabel(analysis.recommendedAction),
        classification,
        route: analysis.route.selectedMethod,
        localRiskGap,
      })}\n`,
    );
  }

  const finalState = replayTimeline(timeline).state;
  const discretionary = decisions.filter(
    (decision) => decision.forced === false,
  );
  const gaps = discretionary.map((decision) => decision.localRiskGap as number);
  const counts = (classification: string): number =>
    decisions.filter((decision) => decision.classification === classification)
      .length;
  const report = {
    schemaVersion: 1,
    reviewedAt: new Date().toISOString(),
    archive: {
      path: archivePath,
      semanticHash: archiveDocument.semanticHash,
      documentHash: archiveDocument.documentHash,
      activeEventCount: events.length,
    },
    solver: {
      selectedConfigId: release.descriptor.configId,
      routingContract: release.descriptor.implementation.routingContract,
      bundleMode: release.binding.bundleMode,
      manifestScope: release.binding.manifestScope,
      budgetId,
      modelRelativeOnly: true,
    },
    observedOutcome: {
      status: finalState.status,
      handCounts: finalState.handCounts,
      activeSeats: finalState.activeSeats,
      escapeGroups: finalState.escapeGroups,
      bhabhi: finalState.bhabhi,
      userSafe: !finalState.activeSeats.includes("user"),
    },
    summary: {
      decisions: decisions.length,
      forced: counts("forced"),
      discretionary: discretionary.length,
      top: counts("top"),
      tied: counts("tied"),
      suboptimal: counts("suboptimal"),
      exactDecisions: decisions.filter(
        (decision) => decision.quality === "Exact",
      ).length,
      approximateDecisions: decisions.filter(
        (decision) => decision.quality === "Approximate",
      ).length,
      meanLocalRiskGap: gaps.length
        ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length
        : 0,
      medianLocalRiskGap: median(gaps),
      maxLocalRiskGap: gaps.length ? Math.max(...gaps) : 0,
      note: "Risk gaps are state-local and must not be summed. Approximate ties use the solver's paired bootstrap decision rule.",
    },
    worstDecisions: [...decisions]
      .filter((decision) => decision.forced === false)
      .sort(
        (left, right) =>
          (right.localRiskGap as number) - (left.localRiskGap as number),
      )
      .slice(0, 5)
      .map((decision) => ({
        ordinal: decision.ordinal,
        eventIndex: decision.eventIndex,
        actualAction: decision.actualAction,
        recommendedAction: decision.recommendedAction,
        classification: decision.classification,
        route: decision.route,
        localRiskGap: decision.localRiskGap,
        actualUserBhabhiRisk: decision.actualUserBhabhiRisk,
        recommendedUserBhabhiRisk: decision.recommendedUserBhabhiRisk,
        handBefore: decision.handBefore,
        leadSuit: decision.leadSuit,
        trickCardsBefore: decision.trickCardsBefore,
      })),
    decisions,
    limitations: [
      "The archive contains public history and the user's cards, not the opponents' original hidden hands.",
      "Optimality is relative to the hard-belief model and documented-basic continuation policies.",
      "Exact means exact within the fixed endgame information-set model; fallback decisions are deterministic Monte Carlo estimates.",
      "One played game cannot establish a win rate or prove that a different move would have changed the realized result.",
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ complete: true, output: outputPath, summary: report.summary })}\n`,
  );
}

await main();
