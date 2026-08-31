import { EmptyState, Shell } from "../shell";

export default function ProjectsPage() {
  return (
    <Shell>
      <EmptyState tag="Setup" title="No Connected Projects yet">
        <p>No Connected Projects exist yet. Registering a project gives MarketingOS its facts, brand, audience, goals, and constraints, and unlocks the project switcher. This is the first setup step.</p>
      </EmptyState>
    </Shell>
  );
}
