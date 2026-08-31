import { EmptyState, Shell } from "../shell";

export default function LearningPage() {
  return (
    <Shell>
      <EmptyState tag="Outcomes" title="No outcomes recorded yet">
        <p>Learning collects experiments, Metric Snapshots, and the decision log. It populates as distribution runs produce measurements and you record decisions against the Evidence Ladder.</p>
      </EmptyState>
    </Shell>
  );
}
