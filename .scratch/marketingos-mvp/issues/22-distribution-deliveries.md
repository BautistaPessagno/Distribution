# 22: Distribution deliveries

**What to build:** Exported work reaches an account by hand, verifiably. A Content Release binds immutably to an export bundle. Delivery Targets pair one release with one Account Instance: idempotency key, ordered queue position, schedule window, and the state path through released_to_operator, posting, proof_submitted, verified_posted with failure and retry. Post Work Orders carry the bundle and disclosure checklist; cancellation after release-to-operator is a request.

**Blocked by:** 14 Lifecycle completion, 21 Caps, kill switch, and replacement.

**Status:** done

- [x] The same idempotency key can never create a second target
- [x] No post order releases without an immutable approved release and completed disclosure checklist
- [x] verified_posted requires proof including the destination permalink
