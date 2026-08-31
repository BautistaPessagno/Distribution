# 10: Atomic edit batches and version history

**What to build:** The shared-document editing contract from the CreativePieceMachine prototype. Typed edit batches (max 20 ops) bound to a `baseVersion`: stale base returns `version_conflict` changing nothing, structural errors reject the whole batch, invalid cosmetic values fall back with a warning. Every applied batch bumps the version; history is append-only; restoring an old version creates a new one; approved pieces reject edits until reopened. Version history renders in Studio.

**Blocked by:** 09 PieceDoc and Studio.

**Status:** done

- [x] Property tests hold the invariants: no lost human writes, append-only history, restore-as-new-version
- [x] Contract tests replay the CreativePieceMachine stale-write and unknown-op scenarios
- [x] Editing an approved piece is refused with the reopen path named

## Comments

- Implemented in https://github.com/BautistaPessagno/Distribution/pull/10: `server/piece-edits.ts` adds `applyEditBatch` (1-20 typed ops bound to a baseVersion; stale base returns `version_conflict` changing nothing, structural errors reject the whole batch, invalid cosmetic fills fall back to `brand.ink` with a warning), an append-only `piece_versions` table (SQL triggers refuse UPDATE/DELETE), `restoreVersion` (restore-as-new-version), and `listVersions`. Approved pieces refuse edits with `piece_not_editable` naming `marketingos.reopen_piece`. New MCP tools `marketingos.apply_edit_batch` / `list_versions` / `restore_version`, operator route `GET /api/pieces/:id/versions`, and Studio renders the version history. Property + contract tests in `tests/piece-edits.test.ts`.
