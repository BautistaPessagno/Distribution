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
import { getMethod } from "./methods";
import {
  applyEditBatchInputSchema,
  applyEditBatch,
  listVersions,
  MAX_BATCH_OPS,
  restoreVersion,
} from "./piece-edits";
import { createPiece, getPiece, listPieces, pieceDocSchema } from "./pieces";
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
    "marketingos.get_method",
    {
      description:
        "Route a marketing goal to its Method Library entry: steps, rubric, and output schema. Chained goals return a persisted MarketingRunPlan; unknown goals return closest-goal suggestions.",
      inputSchema: { goal: z.string() },
    },
    async ({ goal }) => lintedJson(getMethod(sessionKey, goal).response)
  );
  server.registerTool(
    "marketingos.create_piece",
    {
      description:
        "Create a Creative Piece from a PieceDoc (1-20 slides of text/image/shape/logo layers, format 4:5|1:1|9:16|16:9, captions for instagram/x/linkedin/tiktok). The piece is bound to the pinned Project Snapshot and starts in the backlog.",
      inputSchema: { title: z.string(), doc: pieceDocSchema },
    },
    async ({ title, doc }) => lintedJson(createPiece(sessionKey, { title, doc }).response)
  );
  server.registerTool(
    "marketingos.get_piece",
    {
      description:
        "Read one Creative Piece of the selected Connected Project, including its full PieceDoc. Cross-project piece access is refused.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(getPiece(sessionKey, id).response)
  );
  server.registerTool(
    "marketingos.list_pieces",
    {
      description:
        "List the Creative Pieces of the selected Connected Project with status tags.",
      inputSchema: {},
    },
    async () => lintedJson(listPieces(sessionKey).response)
  );
  server.registerTool(
    "marketingos.apply_edit_batch",
    {
      description:
        `Apply an atomic batch of 1-${MAX_BATCH_OPS} typed edit operations (set_text, set_fill, add_layer, remove_layer, set_caption) to a Creative Piece, bound to the baseVersion the batch was computed against. A stale base returns version_conflict changing nothing; structural errors reject the whole batch; invalid cosmetic values fall back with a warning. Each applied batch bumps the version.`,
      inputSchema: applyEditBatchInputSchema.shape,
    },
    async (input) => lintedJson(applyEditBatch(sessionKey, input).response)
  );
  server.registerTool(
    "marketingos.list_versions",
    {
      description:
        "Read the append-only version history of a Creative Piece: version, actor, summary, and timestamp for every saved version.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(listVersions(sessionKey, id).response)
  );
  server.registerTool(
    "marketingos.restore_version",
    {
      description:
        "Restore an old version of a Creative Piece's document as a new version. History stays append-only; nothing is rewritten.",
      inputSchema: { id: z.number(), version: z.number() },
    },
    async ({ id, version }) => lintedJson(restoreVersion(sessionKey, { id, version }).response)
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
