# 13: Review and approval gate

**What to build:** The lifecycle gate. Drafting to review to approved with changes-requested looping back; check_brand errors and unsupported-claim `[NEED]` tokens block approval; quality findings never block. Approval pins the current kit version; a later kit change flags the piece brand-outdated; re-approval re-pins without disturbing status. Reopen clears approval and planned date.

**Blocked by:** 12 Brand Kit and deterministic checks.

**Status:** done

- [x] Approval is refused while a brand error or [NEED] token exists, naming each blocker
- [x] Approval pins the kit version; kit change flags approved work brand-outdated
- [x] Contract tests replay CreativePieceMachine scenarios 3 and 4

## Comments

- Implemented on branch `claude/13-approval-gate`. `server/piece-lifecycle.ts` holds the transitions and the gate: approval refuses while `check_brand` reports an error or an unsupported-claim `[NEED: ...]` token remains, naming every blocker and changing nothing, while `check_quality` findings ride along with the result and never block. Approval pins the Brand Kit version the Operator saw; a kit change flags approved and planned work brand-outdated and leaves backlog and drafting work alone; re-approval re-pins without disturbing status or planned date and is itself refused while a blocker stands. The export renders through the pinned kit, so the artifact that leaves is the one that was approved; the preview keeps repainting, which is how the Operator sees what moved. Approve, request-changes, re-approve, and reopen are Operator acts on `/api/pieces/:id/*` rendered in Studio; the host gets `start_drafting`, `submit_for_review`, `approval_status`, and `reopen_piece`, and no host call can approve. `tests/approval-gate.test.ts` replays CreativePieceMachine walkthroughs 3 and 4 step by step (15 tests). Refusing export while brand-outdated, and the plan transition itself, are ticket 14.
