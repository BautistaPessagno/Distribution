// Brand Kit: the versioned token table one Connected Project's Creative
// Pieces render through (ticket 12; reference behavior: the `brandKit`
// slice of CreativePieceMachine in creative-piece-workflow.html).
//
// A piece's document holds token references (`brand.accent`, `font.display`),
// never copied values, so the kit is a render-time input. Changing a token
// mints a new kit version and repaints every backlog and drafting piece the
// next time it renders, without touching a single stored document.
//
// Kit versions are append-only: nothing is rewritten, so a piece approved
// against kit v1 can still be rendered exactly as the Operator saw it once
// the approval gate (ticket 13) pins it.

import { z } from "zod";
import { audit } from "./audit";
import { getDb } from "./db";
import {
  DEFAULT_BRAND_TOKENS,
  HEX_COLOR_PATTERN,
  TOKEN_NAME_PATTERN,
  type BrandTokens,
} from "../render/piece-slide";

export const REQUIRED_TOKENS = [
  "brand.ink",
  "brand.paper",
  "brand.accent",
  "font.display",
  "font.body",
] as const;

const MAX_FONT_VALUE = 200;

export interface BrandKit {
  projectId: number;
  version: number;
  tokens: BrandTokens;
  actor: string;
  summary: string;
  createdAt: string;
}

interface KitRow {
  project_id: number;
  version: number;
  tokens: string;
  actor: string;
  summary: string;
  created_at: string;
}

function rowToKit(row: KitRow): BrandKit {
  return {
    projectId: row.project_id,
    version: row.version,
    tokens: JSON.parse(row.tokens) as BrandTokens,
    actor: row.actor,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export class BrandKitError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = []
  ) {
    super(message);
    this.name = "BrandKitError";
  }
}

/** Validates a whole token table. Returns the problems, empty when valid. */
export function validateTokens(tokens: BrandTokens): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!TOKEN_NAME_PATTERN.test(name)) {
      problems.push(
        `Token name "${name}" is not a Brand Kit token; names look like brand.<name> or font.<name>.`
      );
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`Token "${name}" has no value.`);
      continue;
    }
    if (name.startsWith("brand.") && !HEX_COLOR_PATTERN.test(value)) {
      problems.push(`Token "${name}" must be a #rrggbb color, not "${value}".`);
    }
    if (name.startsWith("font.") && value.length > MAX_FONT_VALUE) {
      problems.push(`Token "${name}" names a font family longer than ${MAX_FONT_VALUE} characters.`);
    }
  }
  for (const required of REQUIRED_TOKENS) {
    if (!(required in tokens)) problems.push(`Token "${required}" is required and cannot be removed.`);
  }
  return problems;
}

function insertKit(
  projectId: number,
  version: number,
  tokens: BrandTokens,
  actor: string,
  summary: string
): BrandKit {
  getDb()
    .prepare(
      "INSERT INTO brand_kits (project_id, version, tokens, actor, summary) VALUES (?, ?, ?, ?, ?)"
    )
    .run(projectId, version, JSON.stringify(tokens), actor, summary);
  const kit = kitAtVersion(projectId, version);
  if (!kit) throw new Error("brand kit insert did not persist");
  return kit;
}

export function kitAtVersion(projectId: number, version: number): BrandKit | null {
  const row = getDb()
    .prepare("SELECT * FROM brand_kits WHERE project_id = ? AND version = ?")
    .get(projectId, version) as KitRow | undefined;
  return row ? rowToKit(row) : null;
}

/**
 * The kit a project renders through right now. Seeded lazily at v1 with the
 * default tokens, so every project has a kit from its first piece onward.
 */
export function currentKit(projectId: number): BrandKit {
  const row = getDb()
    .prepare("SELECT * FROM brand_kits WHERE project_id = ? ORDER BY version DESC LIMIT 1")
    .get(projectId) as KitRow | undefined;
  if (row) return rowToKit(row);
  return insertKit(projectId, 1, { ...DEFAULT_BRAND_TOKENS }, "system", "Seeded from the default kit");
}

export function listKitVersions(projectId: number): BrandKit[] {
  const rows = getDb()
    .prepare("SELECT * FROM brand_kits WHERE project_id = ? ORDER BY version ASC")
    .all(projectId) as KitRow[];
  return rows.map(rowToKit);
}

export const kitUpdateSchema = z.object({
  // A string sets a token; null removes one, so a token added by mistake is
  // not permanent. The required tokens cannot be removed.
  tokens: z
    .record(z.string(), z.union([z.string(), z.null()]))
    .refine((t) => Object.keys(t).length > 0, {
      message: "Name at least one token to change",
    }),
  summary: z.string().max(200).optional(),
});

/**
 * Set or remove tokens. The change is a merge onto the current kit and mints
 * version + 1; no piece document is touched, so every backlog and drafting
 * piece repaints on its next render.
 */
export function updateKit(
  projectId: number,
  input: unknown,
  actor = "operator"
): BrandKit {
  const parsed = kitUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new BrandKitError(
      "The kit change does not name tokens to set.",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    );
  }

  const current = currentKit(projectId);
  const next: BrandTokens = { ...current.tokens };
  for (const [name, value] of Object.entries(parsed.data.tokens)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  const problems = validateTokens(next);
  if (problems.length > 0) {
    throw new BrandKitError("The kit change was rejected; the kit is unchanged.", problems);
  }

  const changed = Object.keys(parsed.data.tokens).filter(
    (name) => current.tokens[name] !== next[name]
  );
  if (changed.length === 0) return current;

  const summary = parsed.data.summary ?? `Changed ${changed.join(", ")}`;
  const kit = insertKit(projectId, current.version + 1, next, actor, summary);
  audit(actor, "brand-kit.updated", {
    projectId,
    version: kit.version,
    changed,
  });
  return kit;
}
