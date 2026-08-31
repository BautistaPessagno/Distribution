import { EmptyState, Shell } from "../shell";

export default function StudioPage() {
  return (
    <Shell>
      <EmptyState tag="Creative work" title="No Creative Pieces yet">
        <p>Studio holds Creative Pieces: versioned, multi-slide compositions built from Creative Briefs. It populates when an AI Host drafts a piece through the MCP gateway, or when you start one from a Creative Template.</p>
      </EmptyState>
    </Shell>
  );
}
