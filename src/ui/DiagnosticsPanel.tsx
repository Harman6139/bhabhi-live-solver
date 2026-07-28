import { formatCard } from "../domain/cards";
import type { ProductionAnalysis } from "../production/analysis-result";
import {
  formatAnalysisAction,
  formatAnalysisSeat,
  formatDiagnosticNumber,
  formatWholePercent,
} from "./analysis-format";

export type AnalysisIncident = Readonly<{
  kind: "cancellation" | "failure";
  message: string;
  at: string;
}>;

type DiagnosticsPanelProps = {
  readonly analysis: ProductionAnalysis;
  readonly lastIncident: AnalysisIncident | null;
  readonly onDownloadSnapshot: () => void;
};

function PosteriorList({
  title,
  values,
}: {
  readonly title: string;
  readonly values: ProductionAnalysis["diagnostics"]["behavior"]["p2Posterior"];
}) {
  return (
    <section className="diagnostic-subpanel">
      <h4>{title}</h4>
      {values.length === 0 ? (
        <p className="muted">No behavioral posterior is active.</p>
      ) : (
        <ol className="posterior-list">
          {[...values]
            .sort(
              (left, right) =>
                right.probability - left.probability ||
                left.modelId.localeCompare(right.modelId),
            )
            .map((entry) => (
              <li key={entry.modelId}>
                <span>{entry.modelId}</span>
                <strong>{formatWholePercent(entry.probability)}</strong>
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}

export function DiagnosticsPanel({
  analysis,
  lastIncident,
  onDownloadSnapshot,
}: DiagnosticsPanelProps) {
  const hard = analysis.diagnostics.hardConstraints;
  const behavior = analysis.diagnostics.behavior;
  return (
    <details className="panel diagnostics-panel">
      <summary>
        <span>
          Public diagnostics
          <small>Hashes, support, posteriors, seeds, and work</small>
        </span>
      </summary>
      <p className="truth-firewall-note">
        Public-only: this view and its export omit hidden worlds, opponent
        hands, simulator truth, and concrete deals.
      </p>

      <div className="diagnostic-actions">
        <button
          className="button button--secondary"
          type="button"
          onClick={onDownloadSnapshot}
        >
          Download debug snapshot
        </button>
      </div>

      <section aria-labelledby="release-diagnostics-title">
        <h3 id="release-diagnostics-title">Release identity</h3>
        <dl className="diagnostic-grid diagnostic-grid--hashes">
          <div>
            <dt>Selected configuration</dt>
            <dd>{analysis.release.selectedConfigId}</dd>
          </div>
          <div>
            <dt>Routing</dt>
            <dd>{analysis.release.routingContract}</dd>
          </div>
          {Object.entries({
            sourceHash: analysis.release.sourceHash,
            solverConfigHash: analysis.release.solverConfigHash,
            modelHash: analysis.release.modelHash,
            protocolHash: analysis.release.protocolHash,
            selectionAttestationHash: analysis.release.selectionAttestationHash,
            finalAttestationHash: analysis.release.finalAttestationHash,
            historyHash: analysis.identity.historyHash,
            publicStateHash: analysis.identity.publicStateHash,
            analysisHash: analysis.analysisHash,
          }).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="known-diagnostics-title">
        <h3 id="known-diagnostics-title">Known cards and void evidence</h3>
        <div className="diagnostic-columns">
          {(["p2", "p3"] as const).map((seat) => (
            <section className="diagnostic-subpanel" key={seat}>
              <h4>{formatAnalysisSeat(seat)} exact known cards</h4>
              {hard.knownOpponentCards[seat].length === 0 ? (
                <p className="muted">None currently known.</p>
              ) : (
                <ul className="inline-card-list">
                  {hard.knownOpponentCards[seat].map((card) => (
                    <li key={card}>{formatCard(card)}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
        <h4>Known voids · chronological hard evidence</h4>
        {hard.voidObservations.length === 0 ? (
          <p className="muted">No observed void is currently active.</p>
        ) : (
          <ol className="void-list">
            {hard.voidObservations.map((voidEvidence) => (
              <li
                key={`${voidEvidence.eventIndex.toString()}-${voidEvidence.seat}-${voidEvidence.suit}`}
              >
                Event {voidEvidence.eventIndex.toString()}:{" "}
                {formatAnalysisSeat(voidEvidence.seat)} showed{" "}
                {voidEvidence.suit} void by playing{" "}
                {formatCard(voidEvidence.observedCard)} (
                {voidEvidence.kind.replaceAll("-", " ")})
              </li>
            ))}
          </ol>
        )}
        <h4>Estimated voids · inferred</h4>
        <p className="muted">
          Unavailable — ProductionAnalysis exposes hard chronological voids but
          no calibrated per-suit posterior void estimate. No estimate is
          invented.
        </p>
      </section>

      <section aria-labelledby="belief-diagnostics-title">
        <h3 id="belief-diagnostics-title">Belief support</h3>
        <dl className="diagnostic-grid">
          <div>
            <dt>Evidence hash</dt>
            <dd>
              <code>{hard.evidenceHash}</code>
            </dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{analysis.diagnostics.belief.method}</dd>
          </div>
          <div>
            <dt>World occurrences</dt>
            <dd>{analysis.diagnostics.belief.worldOccurrences}</dd>
          </div>
          <div>
            <dt>Distinct witnesses</dt>
            <dd>{analysis.diagnostics.belief.distinctWitnesses}</dd>
          </div>
          <div>
            <dt>Effective sample size</dt>
            <dd>
              {formatDiagnosticNumber(
                analysis.diagnostics.belief.effectiveSampleSize,
              )}
            </dd>
          </div>
          <div>
            <dt>Entropy</dt>
            <dd>
              {formatDiagnosticNumber(analysis.diagnostics.belief.entropy)}
            </dd>
          </div>
          <div>
            <dt>Forced Player 2 cards</dt>
            <dd>{hard.support.forcedP2}</dd>
          </div>
          <div>
            <dt>Forced Player 3 cards</dt>
            <dd>{hard.support.forcedP3}</dd>
          </div>
          <div>
            <dt>Flexible cards</dt>
            <dd>{hard.support.flexible}</dd>
          </div>
          <div>
            <dt>Total feasible worlds</dt>
            <dd>{hard.support.totalWorldCount}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="behavior-diagnostics-title">
        <h3 id="behavior-diagnostics-title">Separate opponent behavior</h3>
        <p>
          {behavior.enabled
            ? "Behavior weighting is enabled."
            : "Behavior weighting is not active for this selected route."}
        </p>
        <div className="diagnostic-columns">
          <PosteriorList
            title="Player 2 posterior"
            values={behavior.p2Posterior}
          />
          <PosteriorList
            title="Player 3 posterior"
            values={behavior.p3Posterior}
          />
        </div>
        <h4>Chronological likelihood contributions</h4>
        {behavior.likelihoodContributions.status === "unavailable" ? (
          <p className="muted">
            Unavailable — {behavior.likelihoodContributions.reason}
          </p>
        ) : behavior.likelihoodContributions.values.length === 0 ? (
          <p className="muted">No voluntary opponent action has contributed.</p>
        ) : (
          <div className="diagnostic-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Seat</th>
                  <th>Observed action</th>
                  <th>Forced</th>
                  <th>Predictive</th>
                  <th>log likelihood</th>
                  <th>ESS</th>
                  <th>Entropy</th>
                </tr>
              </thead>
              <tbody>
                {behavior.likelihoodContributions.values.map((trace) => (
                  <tr
                    key={`${trace.eventIndex.toString()}-${trace.seat}-${trace.decisionOrdinal.toString()}`}
                  >
                    <td>{trace.eventIndex}</td>
                    <td>{formatAnalysisSeat(trace.seat)}</td>
                    <td>{trace.observedActionKey}</td>
                    <td>{trace.forced ? "Known forced" : "Inferred choice"}</td>
                    <td>
                      {formatWholePercent(trace.observedPredictiveProbability)}
                    </td>
                    <td>{trace.logLikelihoodContribution.toFixed(3)}</td>
                    <td>
                      {trace.effectiveSampleSizeBefore.toFixed(2)} →{" "}
                      {trace.effectiveSampleSizeAfter.toFixed(2)}
                    </td>
                    <td>
                      {trace.entropyBefore.toFixed(2)} →{" "}
                      {trace.entropyAfter.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="search-diagnostics-title">
        <h3 id="search-diagnostics-title">Search and candidates</h3>
        <dl className="diagnostic-grid">
          <div>
            <dt>Method</dt>
            <dd>{analysis.route.selectedMethod}</dd>
          </div>
          <div>
            <dt>Quality</dt>
            <dd>{analysis.route.quality}</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>{analysis.budgetId}</dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd>{Math.round(analysis.telemetry.elapsedMs)} ms</dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>
              {analysis.telemetry.deadlineMs} ms ·{" "}
              {analysis.telemetry.deadlineExceeded ? "exceeded" : "met"}
            </dd>
          </div>
          <div>
            <dt>Terminal rollouts</dt>
            <dd>
              {analysis.diagnostics.work.terminalRollouts?.toString() ??
                "Not applicable"}
            </dd>
          </div>
          <div>
            <dt>Weighted hypotheses</dt>
            <dd>
              {analysis.diagnostics.work.weightedHypotheses?.toString() ??
                "Not applicable"}
            </dd>
          </div>
          <div>
            <dt>Exact status</dt>
            <dd>
              {analysis.diagnostics.exact.outcome}
              {analysis.diagnostics.exact.refusalCode === null
                ? ""
                : ` — ${analysis.diagnostics.exact.refusalCode}`}
            </dd>
          </div>
          <div>
            <dt>Fallback</dt>
            <dd>
              {analysis.route.fallback.used
                ? `${analysis.route.fallback.targetConfigId ?? "unknown"} — ${
                    analysis.route.fallback.reasonCode ?? "no reason"
                  }`
                : "Not used"}
            </dd>
          </div>
          <div>
            <dt>Cancellation</dt>
            <dd>
              {lastIncident?.kind === "cancellation"
                ? `${lastIncident.message} · ${lastIncident.at}`
                : "No cancellation retained"}
            </dd>
          </div>
          <div>
            <dt>Last failure</dt>
            <dd>
              {lastIncident?.kind === "failure"
                ? `${lastIncident.message} · ${lastIncident.at}`
                : "No failure retained"}
            </dd>
          </div>
        </dl>

        <div className="diagnostic-table-scroll">
          <table>
            <caption>Published legal candidates</caption>
            <thead>
              <tr>
                <th>Action</th>
                <th>Bhabhi</th>
                <th>Safe</th>
                <th>Tie</th>
              </tr>
            </thead>
            <tbody>
              {analysis.candidates.map((candidate) => (
                <tr key={candidate.actionKey}>
                  <td>{formatAnalysisAction(candidate.action)}</td>
                  <td>{formatWholePercent(candidate.userBhabhiRisk)}</td>
                  <td>{formatWholePercent(candidate.safeProbability)}</td>
                  <td>{candidate.approximateTie ? "Approximate tie" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4>Reproducibility seeds</h4>
        <dl className="diagnostic-grid diagnostic-grid--hashes">
          {Object.entries(analysis.reproducibility).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>

        <h4>Warnings</h4>
        {analysis.warnings.length === 0 ? (
          <p className="muted">No analysis warning was published.</p>
        ) : (
          <ul>
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </section>
    </details>
  );
}
