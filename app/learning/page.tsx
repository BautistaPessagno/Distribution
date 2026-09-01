"use client";

import { ExperimentCard, useExperiments } from "../experiments";
import { EmptyState, Shell } from "../shell";

// Learning. For now this is the experiments board: what was declared, when
// it was declared, and the readings it asked for in advance. Metric
// Snapshots and the decision log land here next.

export default function LearningPage() {
  const experiments = useExperiments();

  return (
    <Shell>
      <section>
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Experiments
        </h2>
        <p className="body-text">
          Declared in full before any work ships: one variable, one primary metric, the rule
          that will decide it, the sample it needs, and what stops it. The declaration cannot
          be edited afterwards, so a result is never explained by a rule that moved.
        </p>
        {experiments.error && <p className="error-text">{experiments.error}</p>}
        {experiments.experiments !== null && experiments.experiments.length === 0 && (
          <EmptyState tag="Outcomes" title="No experiments declared yet">
            <p>
              Learning collects experiments, Metric Snapshots, and the decision log. Declare
              an experiment before the work it is testing ships.
            </p>
          </EmptyState>
        )}
        {experiments.experiments !== null && experiments.experiments.length > 0 && (
          <ul className="connection-list">
            {experiments.experiments.map((experiment) => (
              <ExperimentCard
                key={experiment.id}
                experiment={experiment}
                onChanged={experiments.reload}
              />
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
