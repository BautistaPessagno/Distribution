# 11: Deterministic renderer and PNG export

**What to build:** Preview equals export by construction. The PieceDoc editor and the server renderer share the same React components; live preview in Studio; export renders a PNG per slide per format plus a captions file into a bundle recorded with its doc version and kit version.

**Blocked by:** 10 Atomic edit batches and version history.

**Status:** in-progress

- [ ] Renderer snapshot tests pin that preview and exported PNG come from the same components
- [ ] The export bundle names every file and the versions it was rendered from
- [ ] `render_preview` returns a preview for any piece version
