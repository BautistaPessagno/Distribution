// The image-result handoff (ticket 16; reference behavior: the
// `marketingos.register_asset` case of GatewaySim in ai-host-onboarding.html
// and its walkthrough 3 transcript).
//
// MarketingOS does not generate images. An AI Host does, and hands the
// result back — so every asset records where it came from and on what
// terms, and nothing anywhere claims MarketingOS made it.
//
// The handoff has one happy path and one honest fallback. Inline base64 up
// to the cap is accepted and attached. A host that cannot send binary
// payloads, or a file over the cap, is not an error to paper over: the
// piece drops to `prompt_prepared`, the Operator is pointed at the manual
// dashboard upload, and the piece stays that way until an asset actually
// lands. The manual upload records the same lineage, carried from the
// prompt the host prepared.

import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import {
  noProjectSelected,
  pinnedSession,
  sessionContext,
  type GatewayResult,
} from "./gateway";
import { getPieceById, type PieceRecord } from "./pieces";

/** The inline base64 cap, in bytes of decoded payload. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

export const ASSET_ORIGINS = ["ai_host", "operator_upload", "project_import"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/** Recorded when nobody has said what may be done with the image yet. */
export const RIGHTS_UNREVIEWED = "unreviewed";

export interface AssetRecord {
  id: number;
  ref: string;
  projectId: number;
  origin: AssetOrigin;
  prompt: string | null;
  sourceAssets: string[];
  rights: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

interface AssetRow {
  id: number;
  project_id: number;
  origin: AssetOrigin;
  prompt: string | null;
  source_assets: string;
  rights: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

/**
 * The stable id an image layer references. It never changes and never
 * points anywhere else: assets are immutable, so re-registering produces a
 * new one rather than rewriting this.
 */
export function assetRef(id: number): string {
  return `asset://${id}`;
}

const ASSET_REF = /^asset:\/\/(\d+)$/;

export function assetIdFromRef(ref: string): number | null {
  const match = ASSET_REF.exec(ref);
  return match ? Number(match[1]) : null;
}

function rowToRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    ref: assetRef(row.id),
    projectId: row.project_id,
    origin: row.origin,
    prompt: row.prompt,
    sourceAssets: JSON.parse(row.source_assets) as string[],
    rights: row.rights,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

const METADATA_COLUMNS =
  "id, project_id, origin, prompt, source_assets, rights, media_type, size_bytes, sha256, created_at";

export function getAssetById(id: number): AssetRecord | null {
  const row = getDb()
    .prepare(`SELECT ${METADATA_COLUMNS} FROM assets WHERE id = ?`)
    .get(id) as AssetRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listAssetsForProject(projectId: number): AssetRecord[] {
  const rows = getDb()
    .prepare(`SELECT ${METADATA_COLUMNS} FROM assets WHERE project_id = ? ORDER BY id DESC`)
    .all(projectId) as AssetRow[];
  return rows.map(rowToRecord);
}

export function listAllAssets(): AssetRecord[] {
  const rows = getDb()
    .prepare(`SELECT ${METADATA_COLUMNS} FROM assets ORDER BY id DESC`)
    .all() as AssetRow[];
  return rows.map(rowToRecord);
}

/** The bytes themselves, read only when something actually needs them. */
export function assetBytes(id: number): Buffer | null {
  const row = getDb().prepare("SELECT bytes FROM assets WHERE id = ?").get(id) as
    | { bytes: Buffer }
    | undefined;
  return row ? row.bytes : null;
}

/**
 * Resolve an image layer's `ref` to an asset of the given project. A ref
 * that names an asset of another project resolves to nothing: assets are
 * project-scoped like everything else.
 */
export function resolveAssetRef(ref: string, projectId: number): AssetRecord | null {
  const id = assetIdFromRef(ref);
  if (id === null) return null;
  const asset = getAssetById(id);
  if (!asset || asset.projectId !== projectId) return null;
  return asset;
}

// ---------------------------------------------------------------------------
// The piece's side of the handoff

export type ImageState = null | "prompt_prepared" | `asset_attached:${string}`;

function setImageState(pieceId: number, state: string | null, prompt: string | null): void {
  getDb()
    .prepare("UPDATE pieces SET image_state = ?, image_prompt = ? WHERE id = ?")
    .run(state, prompt, pieceId);
}

/**
 * The prompt a host prepared for a piece whose image never arrived. The
 * manual upload carries it forward as the new asset's lineage, so a file
 * that came in by hand records the same provenance as one that came in
 * over the wire.
 */
export function preparedPrompt(pieceId: number): string | null {
  const row = getDb().prepare("SELECT image_prompt FROM pieces WHERE id = ?").get(pieceId) as
    | { image_prompt: string | null }
    | undefined;
  return row?.image_prompt ?? null;
}

// ---------------------------------------------------------------------------
// Writing an asset

export interface AssetIntake {
  projectId: number;
  origin: AssetOrigin;
  prompt: string | null;
  sourceAssets: string[];
  rights: string;
  mediaType: string;
  bytes: Buffer;
}

export function insertAsset(intake: AssetIntake): AssetRecord {
  const sha256 = createHash("sha256").update(intake.bytes).digest("hex");
  const info = getDb()
    .prepare(
      `INSERT INTO assets
        (project_id, origin, prompt, source_assets, rights, media_type, size_bytes, sha256, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      intake.projectId,
      intake.origin,
      intake.prompt,
      JSON.stringify(intake.sourceAssets),
      intake.rights,
      intake.mediaType,
      intake.bytes.length,
      sha256,
      intake.bytes
    );
  const asset = getAssetById(Number(info.lastInsertRowid));
  if (!asset) throw new Error("asset insert did not persist");
  return asset;
}

/** Attach a registered asset to the piece the handoff was for. */
export function attachToPiece(piece: PieceRecord, asset: AssetRecord, actor: string): void {
  setImageState(piece.id, `asset_attached:${asset.ref}`, preparedPrompt(piece.id) ?? asset.prompt);
  audit(actor, "assets.attached", {
    pieceId: piece.id,
    assetId: asset.id,
    ref: asset.ref,
    origin: asset.origin,
  });
}

// ---------------------------------------------------------------------------
// Host surface: register_asset

function errResult(error: string, message: string, next: string): GatewayResult {
  return { ok: false, response: { error, message, next } };
}

function rightsMissing(message: string, next: string): GatewayResult {
  return errResult("rights_missing", message, next);
}

export const registerAssetInputSchema = z.object({
  origin: z.string().optional(),
  prompt: z.string().optional(),
  sourceAssets: z.array(z.string()).optional(),
  rights: z.string().optional(),
  bytesBase64: z.string().optional(),
  mediaType: z.string().optional(),
  pieceId: z.number().int().optional(),
});

const MEDIA_TYPES: Record<string, string> = {
  "89504e47": "image/png",
  ffd8ffe0: "image/jpeg",
  ffd8ffe1: "image/jpeg",
  ffd8ffdb: "image/jpeg",
  "52494646": "image/webp",
};

/** What the bytes actually are, rather than what the caller said they are. */
export function sniffMediaType(bytes: Buffer): string | null {
  const magic = bytes.subarray(0, 4).toString("hex");
  return MEDIA_TYPES[magic] ?? null;
}

/**
 * The AI Host returns a generated image. Four outcomes, and three of them
 * are refusals that leave the Operator with a next step rather than a dead
 * end. See the walkthrough 3 transcript in ai-host-onboarding.html.
 */
export function registerAsset(sessionKey: string, input: unknown): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();

  const parsed = registerAssetInputSchema.safeParse(input);
  if (!parsed.success) {
    return rightsMissing(
      "The asset registration does not match the expected shape.",
      "Resend with origin, prompt (if generated), sourceAssets, and rights notes."
    );
  }
  const args = parsed.data;

  // 1. Origin is the whole point: MarketingOS never claims it made an image,
  //    so it will not record one that does not say where it came from.
  if (!args.origin || !(ASSET_ORIGINS as readonly string[]).includes(args.origin)) {
    return rightsMissing(
      `origin is required (${ASSET_ORIGINS.join(", ")}).`,
      "Resend with origin, prompt (if generated), sourceAssets, and rights notes."
    );
  }
  const origin = args.origin as AssetOrigin;

  // 2. A generated image without its prompt has no lineage at all.
  if (origin === "ai_host" && !args.prompt) {
    return rightsMissing(
      "Generated assets must carry the prompt and source-asset lineage.",
      "Resend with prompt and sourceAssets."
    );
  }

  const piece =
    args.pieceId !== undefined ? scopedPieceForAsset(args.pieceId, pinned.projectId) : null;

  // 3. No payload: the handoff stays manual, and the piece says so.
  if (!args.bytesBase64) {
    if (piece) setImageState(piece.id, "prompt_prepared", args.prompt ?? null);
    return errResult(
      "asset_bytes_missing",
      "No binary payload arrived. If this host cannot send binary tool payloads, the handoff stays manual." +
        (piece ? ` The piece now shows 'prompt prepared'.` : ""),
      "Tell the Operator to use dashboard manual upload; the piece stays 'prompt prepared' until an asset actually lands."
    );
  }

  const bytes = Buffer.from(args.bytesBase64, "base64");

  // 4. Over the inline cap: the same fallback, for the same reason.
  if (bytes.length > MAX_ASSET_BYTES) {
    if (piece) setImageState(piece.id, "prompt_prepared", args.prompt ?? null);
    return errResult(
      "asset_too_large",
      `Inline payload of ${Math.round(bytes.length / 1024)}KB exceeds the ${Math.round(
        MAX_ASSET_BYTES / 1024
      )}KB cap.` + (piece ? ` The piece now shows 'prompt prepared'.` : ""),
      "Fall back to dashboard manual upload for this file."
    );
  }

  if (bytes.length === 0) {
    return errResult(
      "asset_bytes_missing",
      "The payload decoded to nothing. If this host cannot send binary tool payloads, the handoff stays manual.",
      "Tell the Operator to use dashboard manual upload; the piece stays 'prompt prepared' until an asset actually lands."
    );
  }

  const mediaType = sniffMediaType(bytes);
  if (!mediaType) {
    return errResult(
      "invalid_schema",
      "The payload is not a PNG, JPEG, or WebP image.",
      "Send the image bytes base64-encoded, or upload the file in the dashboard."
    );
  }

  const asset = insertAsset({
    projectId: pinned.projectId,
    origin,
    prompt: args.prompt ?? null,
    sourceAssets: args.sourceAssets ?? [],
    rights: args.rights ?? RIGHTS_UNREVIEWED,
    mediaType,
    bytes,
  });

  audit("ai-host", "assets.registered", {
    assetId: asset.id,
    projectId: pinned.projectId,
    origin,
    sizeBytes: asset.sizeBytes,
    rights: asset.rights,
  });
  if (piece) attachToPiece(piece, asset, "ai-host");

  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      asset: assetSummary(asset),
      piece: piece ? { id: piece.id, imageState: `asset_attached:${asset.ref}` } : null,
      note: "MarketingOS recorded the handoff; it does not claim it generated this image.",
      ...(asset.rights === RIGHTS_UNREVIEWED
        ? {
            warning:
              "No rights notes came with this asset; it is recorded as unreviewed until someone says what may be done with it.",
          }
        : {}),
    },
  };
}

function scopedPieceForAsset(pieceId: number, projectId: number): PieceRecord | null {
  const piece = getPieceById(pieceId);
  if (!piece || piece.projectId !== projectId) return null;
  return piece;
}

export function assetSummary(asset: AssetRecord): Record<string, unknown> {
  return {
    id: asset.id,
    ref: asset.ref,
    origin: asset.origin,
    prompt: asset.prompt,
    sourceAssets: asset.sourceAssets,
    rights: asset.rights,
    mediaType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    createdAt: asset.createdAt,
  };
}

export function listAssets(sessionKey: string): GatewayResult {
  const pinned = pinnedSession(sessionKey);
  if (!pinned) return noProjectSelected();
  return {
    ok: true,
    response: {
      context: sessionContext(sessionKey),
      assets: listAssetsForProject(pinned.projectId).map(assetSummary),
    },
  };
}

// ---------------------------------------------------------------------------
// Operator surface: the manual upload the fallback points at

export class AssetError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AssetError";
  }
}

export interface ManualUpload {
  projectId: number;
  bytes: Buffer;
  pieceId?: number;
  prompt?: string;
  rights?: string;
  sourceAssets?: string[];
}

/**
 * The dashboard fallback. It records the same lineage the inline path would
 * have: the prompt the host prepared, carried forward off the piece, plus
 * the Operator's own confirmation of rights — an Operator uploading a file
 * has looked at it, which is exactly what the inline path cannot assume.
 */
export function uploadAsset(upload: ManualUpload): { asset: AssetRecord; piece: PieceRecord | null } {
  if (upload.bytes.length === 0) throw new AssetError(400, "The upload is empty");
  if (upload.bytes.length > MAX_ASSET_BYTES) {
    throw new AssetError(
      413,
      `The upload is larger than the ${Math.round(MAX_ASSET_BYTES / 1024)}KB cap`
    );
  }
  const mediaType = sniffMediaType(upload.bytes);
  if (!mediaType) throw new AssetError(400, "The upload is not a PNG, JPEG, or WebP image");

  const piece = upload.pieceId !== undefined ? getPieceById(upload.pieceId) : null;
  if (upload.pieceId !== undefined && !piece) {
    throw new AssetError(404, `No piece #${upload.pieceId}`);
  }
  if (piece && piece.projectId !== upload.projectId) {
    throw new AssetError(409, `Piece #${piece.id} belongs to a different Connected Project`);
  }

  const asset = insertAsset({
    projectId: upload.projectId,
    origin: "operator_upload",
    prompt: upload.prompt ?? (piece ? preparedPrompt(piece.id) : null),
    sourceAssets: upload.sourceAssets ?? [],
    rights: upload.rights ?? "operator_confirmed",
    mediaType,
    bytes: upload.bytes,
  });

  audit("operator", "assets.uploaded", {
    assetId: asset.id,
    projectId: upload.projectId,
    pieceId: piece?.id ?? null,
    sizeBytes: asset.sizeBytes,
  });
  if (piece) attachToPiece(piece, asset, "operator");

  return { asset, piece };
}
