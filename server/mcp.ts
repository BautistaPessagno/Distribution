import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ONBOARD_GUIDE } from "./onboard";
import { log } from "./log";

function buildServer(): McpServer {
  const server = new McpServer({ name: "marketingos", version: "0.1.0" });
  server.registerTool(
    "marketingos.onboard",
    {
      description:
        "Returns the compact versioned MarketingOS guide: contract version, session rules, tool map, and example goals.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(ONBOARD_GUIDE, null, 2) }],
    })
  );
  return server;
}

// Stateless mode: a fresh server + transport per request, no session state.
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log("error", "mcp request failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
