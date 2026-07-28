import type {
  ProductionAnalysis,
  ProductionCandidate,
} from "../production/analysis-result";
import {
  causalExplanationText,
  formatAnalysisAction,
  formatCandidateInterval,
  formatWholePercent,
} from "./analysis-format";

type RecommendationPanelProps = {
  readonly analysis: ProductionAnalysis;
  readonly refining: boolean;
};

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="analysis-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail === undefined ? null : <small>{detail}</small>}
    </div>
  );
}

function diagnosticDistribution(
  candidate: ProductionCandidate,
): readonly { readonly label: string; readonly value: string }[] {
  if (candidate.userFinishProbabilities.status === "unavailable") {
    return [
      {
        label: "Finish estimates",
        value: `Unavailable — ${candidate.userFinishProbabilities.reason}`,
      },
    ];
  }
  const finish = candidate.userFinishProbabilities.values;
  return [
    { label: "Finish first", value: formatWholePercent(finish.first) },
    { label: "Finish second", value: formatWholePercent(finish.second) },
    { label: "Bhabhi", value: formatWholePercent(finish.bhabhi) },
    { label: "Tied safe", value: formatWholePercent(finish.tiedSafe) },
  ];
}

function CandidateCard({
  candidate,
  rank,
  recommended,
  exact,
}: {
  readonly candidate: ProductionCandidate;
  readonly rank: number;
  readonly recommended: boolean;
  readonly exact: boolean;
}) {
  const interval = formatCandidateInterval(candidate);
  return (
    <article
      className={`candidate-card ${recommended ? "candidate-card--recommended" : ""}`}
      aria-label={`${rank.toString()}. ${formatAnalysisAction(candidate.action)}${
        recommended ? ", recommended" : ""
      }`}
    >
      <div className="candidate-card__heading">
        <div>
          <span className="candidate-rank">#{rank.toString()}</span>
          <h3>{formatAnalysisAction(candidate.action)}</h3>
        </div>
        {recommended ? (
          <span className="recommend-chip">Recommended</span>
        ) : null}
      </div>
      <div className="candidate-primary-metrics">
        <Metric
          label="Bhabhi"
          value={formatWholePercent(candidate.userBhabhiRisk)}
          detail={
            exact
              ? "Exact under the stated model"
              : interval === null
                ? "Approximate interval unavailable"
                : `95% interval ${interval}`
          }
        />
        <Metric
          label="Safe"
          value={formatWholePercent(candidate.safeProbability)}
        />
        <Metric
          label="Immediate pickup"
          value={
            candidate.immediatePickupProbability === null
              ? "Unavailable"
              : formatWholePercent(candidate.immediatePickupProbability)
          }
          detail={
            candidate.expectedImmediatePickupCount === null
              ? undefined
              : `${candidate.expectedImmediatePickupCount.toFixed(1)} expected cards`
          }
        />
        <Metric
          label="Immediate power"
          value={
            candidate.immediatePowerProbability === null
              ? "Unavailable"
              : formatWholePercent(candidate.immediatePowerProbability)
          }
        />
      </div>
      <dl className="candidate-distribution">
        {diagnosticDistribution(candidate).map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      {candidate.firstOpponentEscape.status === "unavailable" ? (
        <p className="candidate-note">
          Opponent escape estimate unavailable —{" "}
          {candidate.firstOpponentEscape.reason}
        </p>
      ) : (
        <p className="candidate-note">
          First opponent escape: Player 2{" "}
          {formatWholePercent(candidate.firstOpponentEscape.values.p2)} · Player
          3 {formatWholePercent(candidate.firstOpponentEscape.values.p3)} · tie{" "}
          {formatWholePercent(candidate.firstOpponentEscape.values.tie)} · none{" "}
          {formatWholePercent(candidate.firstOpponentEscape.values.none)}
        </p>
      )}
      {candidate.approximateTie ? (
        <p className="tie-note">
          Approximately tied at the estimator’s resolution.
        </p>
      ) : null}
    </article>
  );
}

export function RecommendationPanel({
  analysis,
  refining,
}: RecommendationPanelProps) {
  const ranked = [...analysis.candidates].sort(
    (left, right) =>
      left.userBhabhiRisk - right.userBhabhiRisk ||
      left.actionKey.localeCompare(right.actionKey),
  );
  const recommended = ranked.find(
    (candidate) => candidate.actionKey === analysis.recommendedActionKey,
  );
  if (recommended === undefined) {
    return (
      <section className="panel analysis-error" role="alert">
        Recommendation output omitted its selected legal candidate.
      </section>
    );
  }
  const exact = analysis.route.quality === "Exact";
  const tieKeys = new Set(analysis.approximateTieActionKeys);
  const tied = tieKeys.size > 1 || recommended.approximateTie;
  const reproducibilityId = `${analysis.identity.underlyingAnalysisId}/${analysis.analysisHash}`;

  return (
    <section
      className="panel recommendation-panel"
      aria-labelledby="recommendation-title"
    >
      <div className="analysis-heading">
        <div>
          <p className="eyebrow">Live solver · legal user action</p>
          <h2 id="recommendation-title">
            {formatAnalysisAction(analysis.recommendedAction)}
          </h2>
          <p className="analysis-subtitle">
            {tied
              ? "This recommendation is approximately tied with another legal action; treat the ordering as unresolved."
              : "Lowest displayed terminal Bhabhi estimate among the evaluated legal actions."}
          </p>
        </div>
        <div className="analysis-badges" aria-label="Recommendation quality">
          <span className="evidence-label evidence-label--known">
            Known legal
          </span>
          <span className="evidence-label evidence-label--inferred">
            Inferred outcomes
          </span>
          <span
            className={`evidence-label ${
              exact ? "evidence-label--exact" : "evidence-label--approximate"
            }`}
          >
            {exact ? "Exact" : "Approximate"}
          </span>
          {analysis.diagnostics.sensitivity.status === "available" &&
          analysis.diagnostics.sensitivity.fragile ? (
            <span className="evidence-label evidence-label--sensitive">
              Model-sensitive
            </span>
          ) : null}
        </div>
      </div>

      <div className="recommendation-hero-metrics">
        <Metric
          label="Estimated Bhabhi"
          value={formatWholePercent(recommended.userBhabhiRisk)}
          detail={
            exact
              ? "Exhaustively solved under stated assumptions"
              : formatCandidateInterval(recommended) === null
                ? "Approximate · interval unavailable"
                : `Approximate · 95% interval ${formatCandidateInterval(
                    recommended,
                  )}`
          }
        />
        <Metric
          label="Estimated safe"
          value={formatWholePercent(recommended.safeProbability)}
        />
        <Metric
          label="Method"
          value={analysis.route.selectedMethod}
          detail={`${analysis.budgetId} budget${refining ? " · refining" : ""}`}
        />
        <Metric
          label="World representation"
          value={analysis.diagnostics.belief.worldOccurrences.toString()}
          detail={`${analysis.diagnostics.belief.distinctWitnesses.toString()} distinct witnesses`}
        />
      </div>

      <section className="causal-explanation" aria-labelledby="why-title">
        <h3 id="why-title">Why this changes terminal risk</h3>
        <p>{causalExplanationText(analysis)}</p>
      </section>

      {analysis.diagnostics.sensitivity.status === "available" ? (
        <p
          className={`sensitivity-note ${
            analysis.diagnostics.sensitivity.fragile
              ? "sensitivity-note--fragile"
              : ""
          }`}
        >
          Model sensitivity: {analysis.diagnostics.sensitivity.reason} · maximum
          switch regret{" "}
          {formatWholePercent(
            analysis.diagnostics.sensitivity.maximumSwitchRegret,
          )}
        </p>
      ) : (
        <p className="sensitivity-note">
          Model sensitivity unavailable —{" "}
          {analysis.diagnostics.sensitivity.reason}
        </p>
      )}

      <div className="candidate-list" aria-label="Ranked legal alternatives">
        {ranked.map((candidate, index) => (
          <CandidateCard
            key={candidate.actionKey}
            candidate={candidate}
            rank={index + 1}
            recommended={candidate.actionKey === analysis.recommendedActionKey}
            exact={exact}
          />
        ))}
      </div>

      <details className="analysis-repro">
        <summary>Method and reproducibility identity</summary>
        <dl className="diagnostic-grid">
          <div>
            <dt>Selected configuration</dt>
            <dd>{analysis.release.selectedConfigId}</dd>
          </div>
          <div>
            <dt>Routing contract</dt>
            <dd>{analysis.release.routingContract}</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>{analysis.budgetId}</dd>
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
            <dt>Repro ID</dt>
            <dd>
              <code>{reproducibilityId}</code>
            </dd>
          </div>
          {Object.entries(analysis.reproducibility).map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
