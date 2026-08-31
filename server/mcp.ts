import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { currentKit } from "./brand-kit";
import { checkBrand, checkQuality } from "./checks";
import {
  getResource,
  getSnapshot,
  noProjectSelected,
  pinnedSession,
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
import {
  approvalStatus,
  reopen,
  startDrafting,
  submitForReview,
} from "./piece-lifecycle";
import { createPiece, getPiece, listPieces, pieceDocSchema } from "./pieces";
import { exportPiece, renderPreview } from "./renderer";
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
        `Apply an atomic batch of 1-${MAX_BATCH_OPS} typed edit operations (set_text, set_fill, set_font, add_layer, remove_layer, set_caption) to a Creative Piece, bound to the baseVersion the batch was computed against. A stale base returns version_conflict changing nothing; structural errors reject the whole batch; invalid cosmetic values fall back with a warning. Each applied batch bumps the version.`,
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
    "marketingos.start_drafting",
    {
      description:
        "Move a backlog Creative Piece to drafting, where edits apply.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(startDrafting(sessionKey, { id }).response)
  );
  server.registerTool(
    "marketingos.submit_for_review",
    {
      description:
        "Hand a drafting Creative Piece to the Operator for review. The Operator approves in the dashboard: approval means a person saw that exact document, so no host call can approve.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(submitForReview(sessionKey, { id }).response)
  );
  server.registerTool(
    "marketingos.approval_status",
    {
      description:
        "Read what stands between a Creative Piece and approval: check_brand errors and unsupported-claim [NEED: ...] tokens block it; check_quality findings are reported but never block.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(approvalStatus(sessionKey, { id }).response)
  );
  server.registerTool(
    "marketingos.reopen_piece",
    {
      description:
        "Reopen a Creative Piece in review, approved, or planned back to drafting so it can be edited. Approval and the planned date are cleared; the piece must pass review again.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(reopen(sessionKey, { id }).response)
  );
  server.registerTool(
    "marketingos.get_brand_kit",
    {
      description:
        "Read the Brand Kit of the selected Connected Project: the versioned token table (brand.<name> colors, font.<name> families) that Creative Pieces reference. Pieces hold token names, never copied values, so a kit change repaints backlog and drafting pieces.",
      inputSchema: {},
    },
    async () => {
      const pinned = pinnedSession(sessionKey);
      if (!pinned) return lintedJson(noProjectSelected().response);
      return lintedJson({
        context: sessionContext(sessionKey),
        kit: currentKit(pinned.projectId),
      });
    }
  );
  server.registerTool(
    "marketingos.check_brand",
    {
      description:
        "Run the deterministic brand check over a Creative Piece against its Brand Kit: off-kit colors and fonts, empty text layers, and missing assets are errors that block approval; overflow risk is a warning that does not. Every finding names the slide and layer it is about.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(checkBrand(sessionKey, { id }).response)
  );
  server.registerTool(
    "marketingos.check_quality",
    {
      description:
        "Run the heuristic quality check over a Creative Piece: crowded or empty slides, slides with no text, missing captions. Every finding is advisory and never blocks anything.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson(checkQuality(sessionKey, { id }).response)
  );
  server.registerTool(
    "marketingos.render_preview",
    {
      description:
        "Render a Creative Piece as slide HTML from the shared renderer components — the same components the PNG export screenshots, so preview equals export. Brand Kit tokens are resolved at render time, so the preview reflects the current kit. Pass {id} for the current version or {id, version} for any version in the history.",
      inputSchema: { id: z.number(), version: z.number().optional() },
    },
    async ({ id, version }) => lintedJson(renderPreview(sessionKey, { id, version }).response)
  );
  server.registerTool(
    "marketingos.export_piece",
    {
      description:
        "Export a Creative Piece: render one PNG per slide in headless Chromium from the shared renderer components, plus a captions file, into a bundle whose manifest names every file and the doc and kit versions it was rendered from.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson((await exportPiece(sessionKey, { id })).response)
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
