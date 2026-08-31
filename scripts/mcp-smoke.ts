// Smoke test: connect a real MCP client to the running server and call
// marketingos.onboard. The /mcp endpoint requires host authentication, so a
// token is minted directly in the database (same custody path the dashboard
// uses) unless MCP_TOKEN is provided.
// Usage: MCP_URL=https://host/mcp MCP_TOKEN=moshost_... npm run test:mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp");

async function getToken(): Promise<string> {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const { mintStaticHostToken } = await import("../server/host-auth");
  const { token } = await mintStaticHostToken("mcp-smoke", "mcp-smoke");
  return token;
}

async function expectUnauthenticatedRejected(): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  if (res.status !== 401) {
    throw new Error(`unauthenticated /mcp call returned ${res.status}, expected 401`);
  }
  const body = (await res.json()) as { error?: string };
  if (body.error !== "invalid_token") {
    throw new Error(`unauthenticated /mcp error was ${JSON.stringify(body)}, expected invalid_token`);
  }
}

async function main(): Promise<void> {
  await expectUnauthenticatedRejected();

  const token = await getToken();
  const client = new Client({ name: "mcp-smoke", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  if (!names.includes("marketingos.onboard")) {
    throw new Error(`marketingos.onboard not in tool list: ${names.join(", ")}`);
  }

  const result = await client.callTool({ name: "marketingos.onboard", arguments: {} });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("onboard returned no text content");
  const guide = JSON.parse(text);
  for (const key of ["contract", "rules", "tools", "exampleGoals"]) {
    if (!(key in guide)) throw new Error(`onboard guide missing '${key}'`);
  }

  console.log(`PASS: marketingos.onboard answered with contract ${guide.contract} at ${url}`);
  await client.close();
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
