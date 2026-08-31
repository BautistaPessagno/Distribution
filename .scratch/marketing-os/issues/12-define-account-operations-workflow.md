# Define the Account Operations workflow

Type: grilling
Status: resolved

## Question

What exact Account Slot, Account Instance, warm-up readiness, Operator Assignment, Work Order, proof, review, loss, replacement, daily-limit, and safety rules should govern the sole-Operator MVP?

## Answer

Settled by grilling against [the HumanPost account-warming review](../research/humanpost-account-warming.md). The MVP copies HumanPost's control-plane mechanism with no worker pool: the sole Operator performs every platform action by hand while MarketingOS orchestrates, records, and audits.

### Slots and instances

An `AccountSlot` is durable channel capacity for one Connected Project: platform, identity spec, niche keywords, disclosure rules, risk policy, daily caps, and allowed windows. An `AccountInstance` is the replaceable platform identity filling it: handle, credentials reference (secrets boundary only, never in MCP context, Work Order text, logs, or proofs), readiness state, health, and loss reason.

Slot lifecycle: `requested -> provisioning -> warming -> ready -> active`, with `impaired -> replacing -> warming` for damage, `paused` for the kill switch, and `retired` as the exit. No `awaiting_assignment` state; there is no pool, the Operator self-assigns.

### Readiness: explicit checklist, never elapsed time

An Account Instance becomes ready only when every item is checked, each backed by a Work Order or recorded fact: profile complete, identity and disclosure rules approved, minimum observation sessions logged, niche interactions evidenced through proof, platform health check passed, Operator sign-off. Readiness carries no reach, safety, or permanence promise, per the map's out-of-scope rules.

### Operator Assignments and Work Orders

The owner is the sole Operator, but assignments are still recorded per instance and period, so invited collaborators later are a configuration change, not a redesign (per the first-Operator decision). Work Orders are typed (`provision`, `warmup`, `post`, `comment`, `measure`, `replace`) and keep the full lifecycle even solo: `draft -> awaiting_brand_approval -> queued -> claimed -> in_progress -> proof_submitted -> under_review -> completed`, with `changes_requested` looping to queued and `cancelled`/`failed` exits. Self-review is a deliberate ritual: proof feeds the learning loop. The claim lease timer is skipped while there is a single Operator. Attempts are append-only; a retry is a new attempt, never rewritten history.

### Distribution deliveries

A `ContentRelease` is immutable once approved (it is the exported Creative Piece bundle). Each `DeliveryTarget` pairs one release with one Account Instance: idempotency key, ordered queue position, schedule window, and its own state path `approved -> queued -> released_to_operator -> posting -> proof_submitted -> verified_posted`, with failure and retry states. Once released to the Operator, cancellation is a request, not a guarantee. Multi-account status is derived from targets, never mutated independently.

### Daily limits and the kill switch

Per-slot daily caps and allowed windows with conservative configurable defaults. Caps block: when hit, the queue refuses to release further Work Orders for that account today and shows when the next window opens. A per-slot pause halts all of its work instantly. Caps govern only what MarketingOS hands out; nothing automates the platform action itself.

### Loss and replacement

A lost Account Instance is marked lost with a reason and archived read-only, keeping its history, proofs, and metrics attached. The Account Slot survives and spawns a replacement provisioning Work Order; the new instance re-earns readiness through the full checklist. No silent identity changes, no overprovisioning math (that was a HumanPost operating choice, not domain truth).

### Safety rules

No autonomous follows, comments, posting, or identity creation, ever (map out-of-scope). Every post release requires an immutable approved content version and a completed disclosure checklist. Warming is framed as niche familiarization and audience research, with no enforcement-avoidance claims. The exact niche-engagement actions on the readiness checklist need current platform-policy research, graduated from the fog as its own ticket.
