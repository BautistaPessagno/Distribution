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
  recordPieceOutcome,
  reopen,
  startDrafting,
  submitForReview,
} from "./piece-lifecycle";
import { listAssets, MAX_ASSET_BYTES, registerAsset } from "./assets";
import { createPiece, getPiece, listPieces, pieceDocSchema } from "./pieces";
import { instantiateTemplate, listTemplates, saveAsTemplate } from "./templates";
import { exportPiece, renderPreview } from "./renderer";
import { ONBOARD_GUIDE } from "./onboard";
import { applyChange, changeSetSchema, getApproval, prepareChange } from "./project-changes";
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
    "marketingos.record_outcome",
    {
      description:
        "Record what was observed once an exported Creative Piece had run, moving it to measured.",
      inputSchema: { id: z.number(), outcome: z.string() },
    },
    async ({ id, outcome }) => lintedJson(recordPieceOutcome(sessionKey, { id, outcome }).response)
  );
  server.registerTool(
    "marketingos.register_asset",
    {
      description:
        `Return a generated image to MarketingOS. Inline base64 up to ${Math.round(
          MAX_ASSET_BYTES / 1024
        )}KB, with a required origin (ai_host|operator_upload|project_import); a generated asset must carry its prompt and source-asset lineage, and rights notes are recorded (unreviewed if none come). Missing metadata fails with rights_missing. If this host cannot send binary payloads, or the file is over the cap, the named piece drops to 'prompt prepared' and the Operator uploads it in the dashboard. MarketingOS records the handoff; it never claims it generated the image.`,
      inputSchema: {
        origin: z.string(),
        prompt: z.string().optional(),
        sourceAssets: z.array(z.string()).optional(),
        rights: z.string().optional(),
        bytesBase64: z.string().optional(),
        pieceId: z.number().optional(),
      },
    },
    async (input) => lintedJson(registerAsset(sessionKey, input).response)
  );
  server.registerTool(
    "marketingos.list_assets",
    {
      description:
        "List the registered assets of the selected Connected Project with their origin, prompt lineage, and rights notes. An image layer references one by its stable asset:// id.",
      inputSchema: {},
    },
    async () => lintedJson(listAssets(sessionKey).response)
  );
  server.registerTool(
    "marketingos.save_as_template",
    {
      description:
        "Save a Creative Piece's structure as a Creative Template: the layout, layer order, frames, format, and Brand Kit token references are kept; campaign text, claims, captions, and planning data are stripped. The piece itself is untouched.",
      inputSchema: { id: z.number(), name: z.string().optional() },
    },
    async ({ id, name }) => lintedJson(saveAsTemplate(sessionKey, { id, name }).response)
  );
  server.registerTool(
    "marketingos.list_templates",
    {
      description: "List the Creative Templates of the selected Connected Project.",
      inputSchema: {},
    },
    async () => lintedJson(listTemplates(sessionKey).response)
  );
  server.registerTool(
    "marketingos.instantiate_template",
    {
      description:
        "Start a new Creative Piece from a Creative Template. The piece lands in the backlog with the layout intact and empty copy, bound to the Project Snapshot pinned on this session.",
      inputSchema: { id: z.number(), title: z.string() },
    },
    async ({ id, title }) => lintedJson(instantiateTemplate(sessionKey, { id, title }).response)
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
        "Export a planned Creative Piece: render one PNG per slide in headless Chromium from the shared renderer components, plus a captions file, into a bundle whose manifest names every file and the doc and kit versions it was rendered from. Export happens only from planned, renders through the kit version approval pinned, and refuses while the piece is brand-outdated.",
      inputSchema: { id: z.number() },
    },
    async ({ id }) => lintedJson((await exportPiece(sessionKey, { id })).response)
  );
  server.registerTool(
    "project.prepare_change",
    {
      description:
        "Phase one of a project write. Validates a Project Change Set against the pinned Project Snapshot without touching canonical project state, and returns the digest, the exact diff, the validations run, and any warnings. The Operator then approves or rejects that digest in the dashboard; poll marketingos.get_approval. No grant token is ever given to the host.",
      inputSchema: changeSetSchema.shape,
    },
    async (input) => lintedJson((await prepareChange(sessionKey, input)).response)
  );
  server.registerTool(
    "marketingos.get_approval",
    {
      description:
        "Read the Operator's decision on a prepared change: pending, approved, rejected, or used, each with the one call to make next. Returns a status, never a token.",
      inputSchema: { digest: z.string() },
    },
    async ({ digest }) => lintedJson(getApproval(sessionKey, { digest }).response)
  );
  server.registerTool(
    "project.apply_change",
    {
      description:
        "Phase two of a project write. Applies an approved prepared change atomically and returns a Write Receipt naming the operations applied, the resulting resource versions, and the next change cursor. Refuses before approval, after rejection, on a consumed approval, from another project, or once the project has moved on — each with the recovery path. Call it exactly once per approval.",
      inputSchema: { digest: z.string() },
    },
    async ({ digest }) => lintedJson((await applyChange(sessionKey, { digest })).response)
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
