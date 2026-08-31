# 21: Caps, kill switch, and replacement

**What to build:** The safety rails. Per-slot daily caps and allowed windows block: when hit, the queue refuses further releases for that account today and names the next window. A per-slot pause halts all its work instantly. A lost instance archives read-only with a reason, keeping history, proofs, and metrics; the slot spawns a replacement provisioning Work Order and the new instance re-earns readiness from scratch.

**Blocked by:** 20 Work Orders and the proof cycle.

**Status:** ready-for-agent

- [ ] The cap blocks the next release with next-window messaging; nothing merely warns
- [ ] The kill switch stops releases immediately and visibly
- [ ] Replacement preserves the archived instance and links it from the new one
