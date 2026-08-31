# 09: PieceDoc and Studio

**What to build:** Creative Pieces exist end to end. PieceDoc schema (1-20 slides; text, image, shape, logo layers; four formats; per-network captions for Instagram, X, LinkedIn, TikTok), bound at creation to the pinned Project Snapshot. Gateway tools `create_piece`, `get_piece`, `list_pieces`; Studio in the dashboard lists pieces with status tags and shows a piece's document detail.

**Blocked by:** 04 Dashboard shell and design tokens, 07 Session ritual and Project Snapshots.

**Status:** done

- [x] A host creates a piece bound to the current snapshot; the Operator sees it in Studio
- [x] Cross-project piece access is refused
- [x] All four formats and the captions map round-trip intact

## Comments

- Implemented the PieceDoc schema (zod: 1-20 slides; text/image/shape/logo layers; formats 4:5, 1:1, 9:16, 16:9; per-network captions for instagram/x/linkedin/tiktok), a `pieces` table binding each piece to its creating Project Snapshot, gateway tools `marketingos.create_piece` / `get_piece` / `list_pieces` (cross-project reads refuse with `cross_project_refused`), an Operator `/api/pieces` surface, and the Studio page listing pieces with status tags and a per-piece document detail view. Covered by tests/pieces.test.ts. PR: https://github.com/BautistaPessagno/Distribution/pull/9
