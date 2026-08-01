import type { ProductionAnalysis } from "../production/analysis-result";
import { formatAnalysisAction } from "./analysis-format";
import { PlayingCard } from "./PlayingCard";

type RecommendationPanelProps = {
  readonly analysis: ProductionAnalysis;
  readonly refining: boolean;
};

export function RecommendationPanel({
  analysis,
  refining,
}: RecommendationPanelProps) {
  return (
    <section
      className="recommendation-panel recommendation-panel--single"
      aria-labelledby="recommendation-title"
    >
      {analysis.recommendedAction.kind === "play-card" ? (
        <PlayingCard card={analysis.recommendedAction.card} compact />
      ) : null}
      <div className="recommendation-panel__copy">
        <p className="eyebrow">Top engine move</p>
        <h2 id="recommendation-title">
          {formatAnalysisAction(analysis.recommendedAction)}
        </h2>
      </div>
      <span className="engine-quality">
        {refining
          ? "Refining…"
          : analysis.route.quality === "Exact"
            ? "Exact endgame"
            : "Deep search"}
      </span>
    </section>
  );
}
