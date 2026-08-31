export default function Home() {
  return (
    <main
      style={{
        maxWidth: "40rem",
        margin: "0 auto",
        padding: "6rem 1.5rem",
      }}
    >
      <h1 style={{ fontWeight: 400, fontSize: "1.75rem", marginBottom: "0.5rem" }}>
        MarketingOS
      </h1>
      <hr style={{ border: "none", borderTop: "1px solid #d8d5cf", margin: "1.5rem 0" }} />
      <p style={{ fontFamily: "system-ui, sans-serif", fontSize: "0.9rem", color: "#5a574f" }}>
        The dashboard rail is not built yet. Connect an AI Host to the MCP
        endpoint at <code>/mcp</code> and call <code>marketingos.onboard</code> to
        get started.
      </p>
    </main>
  );
}
