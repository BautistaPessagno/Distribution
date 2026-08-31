# 18: apply_change and Write Receipts

**What to build:** The second half. `project.apply_change(digest)` applies an approved prepared change atomically and returns a Write Receipt (applied operations, resulting versions, next cursor). The refusal matrix from GatewaySim walkthroughs 4 and 5: apply before approval, reuse of a consumed approval, cross-project apply, and apply after an upstream change all refuse with structured errors naming recovery.

**Blocked by:** 17 prepare_change and digest approvals.

**Status:** in-progress

- [ ] A successful apply returns a receipt and advances the snapshot revision
- [ ] Every refusal case matches the reference transcripts
- [ ] Approvals are single-use at the storage level, not by convention
