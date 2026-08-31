import Link from "next/link";
import { EmptyState, Shell } from "./shell";

export default function Home() {
  return (
    <Shell>
      <EmptyState tag="Setup" title="Nothing on the rail yet">
        <p>
          The guided rail fills with the day&apos;s marketing work once MarketingOS is
          set up. Setup starts by connecting your first project: register a Connected
          Project, then link an AI Host to the MCP endpoint at{" "}
          <span className="mono">/mcp</span> and call{" "}
          <span className="mono">marketingos.onboard</span>.
        </p>
        <p>Connect a project to put setup on the rail as your next action.</p>
      </EmptyState>
      <hr className="hairline" />
      <Link className="action-primary" href="/projects" style={{ textDecoration: "none", display: "inline-block" }}>
        Start setup: connect a project
      </Link>
    </Shell>
  );
}
