# 20: Work Orders and the proof cycle

**What to build:** The full human-work lifecycle even solo: typed Work Orders (provision, warmup, post, comment, measure, replace) walking draft, approval, queued, claimed, in_progress, proof_submitted, under_review, completed, with changes-requested looping and cancelled/failed exits. Proof is required for completion; attempts are append-only; self-review is a real step. Warm-up orders carry the one-instruction format the guided rail will consume.

**Blocked by:** 19 Account Slots, Instances, and readiness.

**Status:** ready-for-agent

- [ ] No Work Order completes without proof; retries create new attempts, never rewrites
- [ ] Every transition is audited with actor and timestamp
- [ ] A warm-up order renders as one plain instruction plus a proof field
