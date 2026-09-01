"use client";

import { LearningEntryCard, useLearningLog } from "../decisions";
import { ExperimentCard, useExperiments } from "../experiments";
import { EmptyState, Shell } from "../shell";
import { FunnelRead, SnapshotTable, useSnapshots } from "../snapshots";

// Learning. For now this is the experiments board: what was declared, when
// it was declared, and the readings it asked for in advance. Metric
// Snapshots and the decision log land here next.

export default function LearningPage() {
  const experiments = useExperiments();
  const snapshots = useSnapshots();
  // The log is per project; the experiments board already knows which
  // projects have any, so the first one is the one to show.
  const projectId = experiments.experiments?.[0]?.projectId ?? null;
  const learning = useLearningLog(projectId);

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
        <hr className="hairline" />
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Learning log
        </h2>
        <p className="body-text">
          Every concluded experiment, with what its evidence supports, what it does not, and
          the rung that evidence reaches. Funnel movements sit beside a decision and never
          underneath it: a correlation may justify the next test and is never proof of what
          caused it.
        </p>
        {learning.error && <p className="error-text">{learning.error}</p>}
        {learning.log !== null && learning.log.entries.length === 0 && (
          <p className="body-text">Nothing concluded yet.</p>
        )}
        {learning.log !== null && learning.log.entries.length > 0 && (
          <ul className="connection-list">
            {learning.log.entries.map((entry) => (
              <LearningEntryCard key={entry.experimentId} entry={entry} />
            ))}
          </ul>
        )}

        <hr className="hairline" />
        <h2 className="headline" style={{ fontSize: "1.1rem" }}>
          Metric Snapshots
        </h2>
        <p className="body-text">
          Two observation sources, and every reading says which it was: read by hand through
          a measure Work Order, or read from the project&rsquo;s own product funnel with the
          snapshot it came out of. Nothing is ever overwritten — a further reading of the
          same metric is another row, because two readings are two facts.
        </p>
        <FunnelRead onRead={snapshots.reload} />
        {snapshots.error && <p className="error-text">{snapshots.error}</p>}
        {snapshots.snapshots !== null && snapshots.snapshots.length === 0 && (
          <p className="body-text">No observations recorded yet.</p>
        )}
        {snapshots.snapshots !== null && snapshots.snapshots.length > 0 && (
          <SnapshotTable snapshots={snapshots.snapshots} />
        )}
      </section>
    </Shell>
  );
}
