# 18: apply_change and Write Receipts

**What to build:** The second half. `project.apply_change(digest)` applies an approved prepared change atomically and returns a Write Receipt (applied operations, resulting versions, next cursor). The refusal matrix from GatewaySim walkthroughs 4 and 5: apply before approval, reuse of a consumed approval, cross-project apply, and apply after an upstream change all refuse with structured errors naming recovery.

**Blocked by:** 17 prepare_change and digest approvals.

**Status:** done

- [x] A successful apply returns a receipt and advances the snapshot revision
- [x] Every refusal case matches the reference transcripts
- [x] Approvals are single-use at the storage level, not by convention

## Comments

- Implemented on branch `claude/18-apply-change`. `project.apply_change` walks the refusal matrix in the reference's order — unknown digest, prepared for another project (naming both), already consumed, rejected, not yet approved, and stale even on an approved digest — then consumes the approval and applies at the project, returning a Write Receipt with the operations applied, the resulting resource versions, the actor, and the next cursor. The session is re-pinned to the new revision. Single-use is enforced in storage rather than by convention: consuming is a conditional UPDATE whose row count decides, a trigger forbids a consumed approval from ever changing again, and one receipt per digest is a uniqueness constraint; receipts are append-only. The approval is consumed *before* the project write, because a double write is far worse than a wasted approval; the window that opens is closed by requiring `apply` to be idempotent on the digest in the project contract, and a failed apply says plainly that whether the change landed is unknown rather than guessing. `server/project-domain-sdk.ts` gained `POST /apply` as an optional capability — a project domain that does not implement it accepts no writes — and the dev stub implements it so the whole loop can be walked locally. Covered by `tests/apply-change.test.ts` (15 tests), replaying GatewaySim walkthroughs 4 and 5 step by step and asserting the storage guarantees directly against SQLite. Not yet recorded on a receipt: content hashes and the validations that ran (ticket 08's fuller shape).
