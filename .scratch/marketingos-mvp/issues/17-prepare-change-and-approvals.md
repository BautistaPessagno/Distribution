# 17: prepare_change and digest approvals

**What to build:** The first half of two-phase project writes. `project.prepare_change` validates a Project Change Set against the pinned snapshot without touching canonical state and returns the digest, exact diff, validations, and warnings. The digest lands in the dashboard as an explicit interruption (never a guided-rail step) showing the diff; the Operator approves or rejects; the host polls `get_approval(digest)`. No grant token ever transits the host.

**Blocked by:** 04 Dashboard shell and design tokens, 07 Session ritual and Project Snapshots.

**Status:** in-progress

- [ ] Preparing a change creates a pending digest visible in the dashboard with its exact diff
- [ ] get_approval reports pending, approved, and rejected with the correct next action
- [ ] A stale snapshot refuses preparation with the recovery path
