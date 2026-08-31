# 11: Deterministic renderer and PNG export

**What to build:** Preview equals export by construction. The PieceDoc editor and the server renderer share the same React components; live preview in Studio; export renders a PNG per slide per format plus a captions file into a bundle recorded with its doc version and kit version.

**Blocked by:** 10 Atomic edit batches and version history.

**Status:** done

- [x] Renderer snapshot tests pin that preview and exported PNG come from the same components
- [x] The export bundle names every file and the versions it was rendered from
- [x] `render_preview` returns a preview for any piece version

## Comments

- Implemented in PR https://github.com/BautistaPessagno/Distribution/pull/11: shared `render/piece-slide.tsx` SlideView renders both the Studio live preview and the server renderer; `marketingos.render_preview` returns slide HTML for any version in the history; `marketingos.export_piece` screenshots the same HTML in headless Chromium (Playwright) into a `data/exports/piece-<id>-v<version>/` bundle (PNG per slide + captions.json) whose manifest names every file, the doc version, the kit version (null until the Brand Kit ticket), and the source HTML hash each PNG was rendered from; bundles are recorded in the new `piece_exports` table. Snapshot/contract tests in `tests/renderer.test.ts`.
