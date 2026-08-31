# 17: prepare_change and digest approvals

**What to build:** The first half of two-phase project writes. `project.prepare_change` validates a Project Change Set against the pinned snapshot without touching canonical state and returns the digest, exact diff, validations, and warnings. The digest lands in the dashboard as an explicit interruption (never a guided-rail step) showing the diff; the Operator approves or rejects; the host polls `get_approval(digest)`. No grant token ever transits the host.

**Blocked by:** 04 Dashboard shell and design tokens, 07 Session ritual and Project Snapshots.

**Status:** done

- [x] Preparing a change creates a pending digest visible in the dashboard with its exact diff
- [x] get_approval reports pending, approved, and rejected with the correct next action
- [x] A stale snapshot refuses preparation with the recovery path

## Comments

- Implemented on branch `claude/17-prepare-change`. `server/project-changes.ts` holds `project.prepare_change`: it validates a Project Change Set against the pinned Project Snapshot and the Connected Project's own write policy, writes nothing canonical, and returns the digest, the exact diff, the validations run, and any warnings. A protected target or an unaccepted operation is refused by name and prepares nothing; a project that declares no write policy permits nothing, while a project that cannot be reached is an outage rather than a refusal. The digest is derived from project, snapshot, and change, so it names one change against one snapshot; preparing the same change twice addresses the waiting approval, and an already-decided one refuses rather than reading as a fresh preparation. A stale snapshot refuses with the recovery path, naming the resources the change would have touched. `marketingos.get_approval` answers with a status and one next call and nothing else — no grant token transits the host, asserted by key set. `/api/approvals` shows every prepared change with its exact diff; decisions are final and single-writer. The dashboard renders pending digests as an interruption above the Today view, outside the rail and numbered nowhere, with the full history on Operations. Covered by `tests/prepare-change.test.ts` (17 tests). Deferred and recorded: project-declared validators, accepted formats and limits, the asset manifest, and the wider operation set from ticket 08. `project.apply_change` and Write Receipts are ticket 18.
