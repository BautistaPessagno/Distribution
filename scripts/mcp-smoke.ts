// Smoke test: connect a real MCP client to the running server and call
// marketingos.onboard. Usage: MCP_URL=https://host/mcp npm run test:mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp");

async function main(): Promise<void> {
  const client = new Client({ name: "mcp-smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));

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
