# 10: Atomic edit batches and version history

**What to build:** The shared-document editing contract from the CreativePieceMachine prototype. Typed edit batches (max 20 ops) bound to a `baseVersion`: stale base returns `version_conflict` changing nothing, structural errors reject the whole batch, invalid cosmetic values fall back with a warning. Every applied batch bumps the version; history is append-only; restoring an old version creates a new one; approved pieces reject edits until reopened. Version history renders in Studio.

**Blocked by:** 09 PieceDoc and Studio.

**Status:** in-progress

- [ ] Property tests hold the invariants: no lost human writes, append-only history, restore-as-new-version
- [ ] Contract tests replay the CreativePieceMachine stale-write and unknown-op scenarios
- [ ] Editing an approved piece is refused with the reopen path named
