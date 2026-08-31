import express, { type Request, type Response, type Router } from "express";
import { validateSession } from "./auth";
import { sessionTokenFrom } from "./auth-routes";
import {
  assetBytes,
  assetSummary,
  attachedState,
  AssetError,
  getAssetById,
  listAllAssets,
  uploadAsset,
} from "./assets";
import { log } from "./log";
import { listProjects } from "./projects";

// Operator surface for assets, and specifically for the manual upload the
// image handoff falls back to when a host cannot send binary payloads or
// the file is over the inline cap.
export function assetRouter(): Router {
  const router = express.Router();
  // Base64 is 4/3 the size of the bytes, so a 2MB image needs ~2.7MB of
  // body, plus the metadata around it.
  router.use(express.json({ limit: "4mb" }));

  router.use((req: Request, res: Response, next) => {
    if (validateSession(sessionTokenFrom(req)) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  });

  router.get("/", (_req, res) => {
    const names = new Map(listProjects().map((p) => [p.id, p.name]));
    res.json({
      assets: listAllAssets().map((asset) => ({
        ...assetSummary(asset),
        projectId: asset.projectId,
        projectName: names.get(asset.projectId) ?? `project #${asset.projectId}`,
      })),
    });
  });

  // The bytes, for the dashboard to show what actually landed.
  router.get("/:id/bytes", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid asset id" });
      return;
    }
    const asset = getAssetById(id);
    const bytes = asset ? assetBytes(id) : null;
    if (!asset || !bytes) {
      res.status(404).json({ error: `No asset #${id}` });
      return;
    }
    // These bytes arrived from an AI Host and are served back from the
    // dashboard's own origin under the Operator's session. The media type is
    // this process's own sniff, never the caller's claim, and nosniff stops
    // a browser from second-guessing it into something executable.
    res.setHeader("Content-Type", asset.mediaType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    // Assets are immutable, so this is safe to hold onto.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(bytes);
  });

  router.post("/", (req, res) => {
    try {
      const projectId = Number(req.body?.projectId);
      if (!Number.isInteger(projectId) || !listProjects().some((p) => p.id === projectId)) {
        res.status(400).json({ error: "A known Connected Project id is required" });
        return;
      }
      const base64 = typeof req.body?.bytesBase64 === "string" ? req.body.bytesBase64 : "";
      if (!base64) {
        res.status(400).json({ error: "The upload needs the file's bytes, base64-encoded" });
        return;
      }
      const pieceId = req.body?.pieceId === undefined ? undefined : Number(req.body.pieceId);
      if (pieceId !== undefined && !Number.isInteger(pieceId)) {
        res.status(400).json({ error: "Invalid piece id" });
        return;
      }

      const { asset, piece } = uploadAsset({
        projectId,
        bytes: Buffer.from(base64, "base64"),
        pieceId,
        prompt: typeof req.body?.prompt === "string" ? req.body.prompt : undefined,
        rights: typeof req.body?.rights === "string" ? req.body.rights : undefined,
      });

      res.json({
        asset: assetSummary(asset),
        piece: piece ? { id: piece.id, imageState: attachedState(asset.ref) } : null,
        note: piece
          ? `Uploaded ${asset.ref} through the dashboard; lineage recorded from the prepared prompt, and the piece is no longer waiting on an image.`
          : `Uploaded ${asset.ref} through the dashboard.`,
      });
    } catch (err) {
      if (err instanceof AssetError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      log("error", "asset upload failed", {
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
