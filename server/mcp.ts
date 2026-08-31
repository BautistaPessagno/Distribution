import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getResource,
  getSnapshot,
  selectProject,
  sessionContext,
} from "./gateway";
import { ONBOARD_GUIDE } from "./onboard";
import { assertNoSecretShapedStrings, ResponseLintError } from "./response-lint";
import { log } from "./log";

type ToolResult = { content: { type: "text"; text: string }[] };

// Custody boundary: every tool response is linted for secret-shaped
// strings before it leaves the process.
function lintedJson(payload: unknown): ToolResult {
  const result: ToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
  try {
    assertNoSecretShapedStrings(result);
  } catch (err) {
    if (err instanceof ResponseLintError) {
      log("error", "response failed secret lint", { findings: err.findings });
      throw new Error("Response blocked: it contained secret-shaped content.");
    }
    throw err;
  }
  return result;
}

function buildServer(sessionKey: string): McpServer {
  const server = new McpServer({ name: "marketingos", version: "0.1.0" });
  server.registerTool(
    "marketingos.onboard",
    {
      description:
        "Returns the compact versioned MarketingOS guide: contract version, session rules, tool map, and example goals.",
      inputSchema: {},
    },
    async () => lintedJson({ context: sessionContext(sessionKey), ...ONBOARD_GUIDE })
  );
  server.registerTool(
    "marketingos.select_project",
    {
      description:
        "Pin this session to one Connected Project. Captures an immutable Project Snapshot; every later response echoes {project, snapshot, contract}.",
      inputSchema: { project: z.string() },
    },
    async ({ project }) => lintedJson((await selectProject(sessionKey, project)).response)
  );
  server.registerTool(
    "project.get_snapshot",
    {
      description:
        "Refresh the pinned Project Snapshot for the selected Connected Project. The recovery path for stale_snapshot.",
      inputSchema: {},
    },
    async () => lintedJson((await getSnapshot(sessionKey)).response)
  );
  server.registerTool(
    "project.get_resource",
    {
      description:
        "Read brand, claims, or profile from the pinned Project Snapshot with field provenance. Context Gaps surface as data states, never silent omissions.",
      inputSchema: { resource: z.string() },
    },
    async ({ resource }) => lintedJson((await getResource(sessionKey, resource)).response)
  );
  return server;
}

// The gateway session is keyed by the authenticated host's token: one
// connection, one session, one pinned snapshot. The token itself is never
// stored — only a hash used as the session key.
function sessionKeyFrom(req: Request): string {
  const token = (req as Request & { auth?: { token?: string } }).auth?.token ?? "";
  return createHash("sha256").update(token).digest("hex");
}

// Stateless transport: a fresh server + transport per request. Session state
// lives in the gateway module, keyed by the host connection.
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = buildServer(sessionKeyFrom(req));
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
