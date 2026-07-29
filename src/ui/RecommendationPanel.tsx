import type { ProductionAnalysis } from "../production/analysis-result";
import { formatAnalysisAction } from "./analysis-format";

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
      <div>
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
