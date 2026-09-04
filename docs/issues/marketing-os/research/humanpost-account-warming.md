# HumanPost account warming: product mechanics for MarketingOS

Research date: 2026-08-30. Sources are first-party HumanPost pages, its official API/MCP documentation, legal pages, and the supplied founder post. Landing-page metrics and promises are reported as company claims, not independently verified facts. Recommendations below describe a native MarketingOS feature, not a HumanPost integration.

## Executive product conclusion

HumanPost's important mechanism is not “automated warming.” It is a software-coordinated human operations system:

1. A brand specifies an account identity and niche.
2. Software sends that specification to a worker pool and assigns a human.
3. The human creates the account and manually performs niche-relevant engagement.
4. Approved content becomes one ordered queue item per target account.
5. A human publishes natively and supplies proof.
6. Software aggregates proof, status, metrics, limits, and experiments.
7. The customer buys replaceable **account capacity**, not a guaranteed permanent handle.

This reading is supported by HumanPost's own sequence—design accounts, automatically assign U.S. posters, warm with keywords/product context, upload content, observe manual tasks, and track performance—and by the MCP definition of account creation as sending a profile to a worker invite pool. [Product and FAQ](https://humanpost.co/) · [MCP tool catalog](https://humanpost.co/docs/mcp)

For MarketingOS, copy the control-plane mechanism but begin with a single operator (the user) or a small invited team. A labor marketplace, U.S.-only workforce, performance billing, and mass account fleet are not necessary to validate the MVP.

## Observed lifecycle

### 1. Request and provisioning

- The customer supplies `platform` (`tiktok` or `instagram`), desired `username`, optional `displayName`, and a required warm-up object with 1–20 `searchTerms`. The API also exposes `managedPostingEnabled` and optional account email/password fields. [Account API](https://humanpost.co/docs/api)
- Via MCP, `create_account` sends a “complete account profile” into a worker invite pool. HumanPost says a U.S.-based poster is assigned automatically; the poster creates the account to the customer's profile photo, username, bio, and terms. Posters have no creative control. [MCP tool catalog](https://humanpost.co/docs/mcp) · [Product and FAQ](https://humanpost.co/)
- The supplied founder launch post claims account fleets can be dedicated to one company, operated by real U.S. people, warmed for the niche, and run without VPNs. These are launch claims, not details of the verification method. [Founder post](https://x.com/itsmehakvohra/status/2093448950384820647)

### 2. Niche warming

- The customer supplies niche keywords and product context. A human then scrolls, likes, reposts, and follows relevant content before the account starts posting; HumanPost says warm-up, posting, and comment tasks are completed by hand. [Product workflow](https://humanpost.co/)
- The public API documents the warm-up **input**, but it exposes no warm-up plan, action quantities, duration, completion threshold, proof schema, or readiness transition. Account responses contain `status: string`, while MCP only promises “readiness.” Therefore the exact account lifecycle and warming algorithm are undocumented. [Account API](https://humanpost.co/docs/api) · [MCP tool catalog](https://humanpost.co/docs/mcp)

### 3. Content release and posting

- Software imports or validates media, creates a post, and adds one ordered queue item per selected account. Inputs include caption, hashtags, sound mode/URLs, operator notes, priority, `scheduledAfter`, and Instagram format; an account exposes timezone, `dailyCap`, posts today, queue depth, next window, and last-post time. [API reference](https://humanpost.co/docs/api)
- Customer approval and HumanPost review are separate implied gates: the terms put pre-publication review and approval responsibility on the customer, while the publishing lifecycle includes `pending_approval`, explicitly waiting for a HumanPost reviewer. [Terms, §§5–7](https://humanpost.co/terms-of-service) · [Status lifecycle](https://humanpost.co/docs)
- After internal approval, a human operator takes the released queue item and publishes it natively. Cancellation is no longer assured once the item is in an operator's hands, and a posted item cannot be deleted through HumanPost. [Errors and cancellation](https://humanpost.co/docs/errors) · [API cancellation response](https://humanpost.co/docs/api)

### 4. Proof and learning

- HumanPost claims it handles assignment, instructions, reminders, proof collection, reporting, and task quality rather than making the customer coordinate posters. Its privacy policy confirms task executors, submitted proof, task status, performance metrics, communications, payouts, and proof review are stored/processed. The public API does not expose the proof artifact itself or the review result. [FAQ](https://humanpost.co/) · [Privacy, §§2–4](https://humanpost.co/privacy-policy)
- Post analytics include views, likes, comments, shares, saves, engagement rate, platform/account/post URL, collection time, history, and a `taskId`; account analytics add followers, post count, engagement, and scanned-post count. [Analytics API](https://humanpost.co/docs/api)
- HumanPost frames operations as experiments: monitor results, test formats, and scale what works. Its content-strategist role describes maintaining at least a three-day content buffer, testing hooks/formats/schedules, reviewing results weekly, and turning missing assets into briefs. This is useful operational evidence, not part of the public API contract. [Product](https://humanpost.co/) · [Content strategist role](https://humanpost.co/careers/content-strategist)

## Human work versus software work

| Human | Software/control plane |
| --- | --- |
| Create the platform account to the supplied identity specification | Validate and store the account specification; route it to a worker pool; assign the operator |
| Scroll, like, repost, follow, and perform comment tasks in-niche | Turn keywords/context into instructions; queue tasks; send reminders; show progress |
| Manually publish supplied, approved content on TikTok/Instagram | Validate/process media; apply limits; schedule and order one delivery per account |
| Submit proof and respond to rejected/retry work | Collect proof, review/verify quality, report status, and retain an audit history |
| A HumanPost reviewer approves a post for release | Aggregate per-target status; collect metrics; expose analytics, usage, and experiments |

The landing page also says “100% posts done by hand.” This does not mean the overall system is manual: the API and privacy policy explicitly describe automation for routing, rendering, scheduling, verification, analytics, and AI-assisted operations. [Product](https://humanpost.co/) · [Privacy, §§3 and 7](https://humanpost.co/privacy-policy)

## Exact documented states and controls

### Published HumanPost post states

`draft → pending_approval → queued → posting → posted`

Additional aggregate/terminal states: `partially_posted`, `processing`, `cancelled`, `failed`. HumanPost defines these publicly. A post contains per-account targets with their own status and timestamps (`queuedAt`, `approvedAt`, `scheduledAfter`, `scheduledSlotStart`, `postedAt`) plus `postUrl`. [Status lifecycle](https://humanpost.co/docs) · [Post API](https://humanpost.co/docs/api)

Important semantics:

- One post may fan out to as many as 50 account targets, which is why `partially_posted` exists. [Post API](https://humanpost.co/docs/api)
- Metadata is editable only while the post remains in an editable status; the exact editable subset is not named. [Post API](https://humanpost.co/docs/api) · [Errors](https://humanpost.co/docs/errors)
- Cancellation can target the whole post or one account. The response separates cancelled targets from skipped targets such as `currently_posting`. [Cancellation API](https://humanpost.co/docs/api)
- `POST /posts` and `/posts/{id}/queue` accept an optional idempotency key; a replay returns 200 rather than creating duplicate work. A duplicate account queue item is a conflict. [Quickstart](https://humanpost.co/docs/quickstart) · [Errors](https://humanpost.co/docs/errors)
- HumanPost documents validation, quota, rate-limit, missing account, media-not-ready, duplicate, not-editable, and not-cancellable failures, each with a corrective hint and request ID. It does **not** document automatic retry schedules, retry limits, dead-letter handling, or operator reassignment. [Errors](https://humanpost.co/docs/errors)

### Not published as exact states

- **Account state:** account responses deliberately expose an unconstrained `status: string`; no enum or transition rules are published.
- **Warm-up task state:** no public object, enum, completion rule, or proof schema.
- **Operator assignment state:** the worker invite pool and automatic assignment are named, but offer/accept/claim/reassignment states are not.
- **Proof review state:** proof collection and review exist, but acceptance/rejection/revision states and evidence requirements are not public.
- **Comment/SparkCode jobs:** plan allowances exist, but their request shapes and lifecycles are absent from the public API/MCP docs.

Do not present inferred values for these as “HumanPost states.”

## Account loss, capacity, and economics

- HumanPost explicitly sells **slots, not permanent accounts**. It says lost/deleted accounts are automatically replaced, the username may change, and customers should provision 20–25% more slots than their desired active capacity. Permanent account management costs extra. [Account creation note](https://humanpost.co/docs)
- This implies a two-level model: a durable commercial/operational slot and a replaceable platform-account instance. It also implies account loss is expected capacity churn, although HumanPost does not publish loss causes, rates, replacement SLA, state transfer, follower/content recovery, or who owns credentials after replacement.
- Current visible quarterly pricing claims: Learning is $180/month billed $540 quarterly plus a $100 prepaid view balance, 200 monthly posts, up to five accounts, $2.50 per 1,000 views, and a $250 maximum view charge per post; Scaling is $1,125/month billed $3,375 quarterly, 250 monthly posts, up to eight accounts, and no view fees. Credits renew monthly without rollover. [Pricing and FAQ](https://humanpost.co/)
- On Learning, unused view balance remains available and is withdrawable, but posting pauses if the balance is below the required reserve; “low” is below 20% of the deposit. HumanPost claims Scaling customers averaged $0.67 CPM over the preceding 90 days. These are vendor-defined billing rules and a rolling vendor claim, not guaranteed performance. [Pricing and FAQ](https://humanpost.co/)

MarketingOS should keep three ledgers separate: subscription/capacity, human-task cost, and media-performance spend. Otherwise a CPM-based experiment can hide the true labor cost of account creation, warming, replacement, and proof review.

## Risks visible in first-party evidence

These are product/compliance risks, not legal conclusions.

- **Platform enforcement:** HumanPost expressly lists bans, locks, verification checks, throttling, takedowns, reduced reach, deleted content, lost followers, and lost access as risks borne by the customer; it does not guarantee account safety, delivery timing, post permanence, reach, or results. [Terms, §§8 and 13](https://humanpost.co/terms-of-service)
- **Identity and disclosure:** its acceptable-use terms prohibit impersonation, fake endorsements, missing required sponsorship/affiliate/platform disclosures, spam, harassment, deception, platform-rule violations, and security circumvention. MarketingOS needs explicit operator identity, brand authorization, disclosure requirements, and content approval records. [Terms, §§4–7](https://humanpost.co/terms-of-service)
- **Credential/data exposure:** the API can accept account credentials, while the privacy policy says HumanPost may collect access tokens and share usernames, profile details, content, captions, instructions, links, and proof requirements with task executors. It may retain approvals, task logs, proof links, account activity, analytics, payouts, billing, and support history after an account/campaign ends. [Account API](https://humanpost.co/docs/api) · [Privacy, §§2, 4, and 6](https://humanpost.co/privacy-policy)
- **AI/vendor processing:** customer content, campaign instructions, account information, media, comments, and analytics may be sent to AI or automated providers; HumanPost warns against submitting unnecessary sensitive data and does not promise absolute security. [Privacy, §§5 and 7](https://humanpost.co/privacy-policy)
- **Inference—coordinated activity:** large fleets of brand-dedicated accounts performing scripted engagement could be treated by a target platform as spam, manipulation, or inauthentic behavior depending on that platform's rules. HumanPost itself requires platform compliance and disclaims enforcement outcomes, but does not document how its warm-up recipe is evaluated against each platform's current policies. [Terms, §§4 and 8](https://humanpost.co/terms-of-service)

## Smallest independent MarketingOS model

The MVP should model the operation, not clone HumanPost's API.

| Entity | Minimum responsibility |
| --- | --- |
| `ConnectedProject` | Product/brand context received from that project's MCP server; source facts stay linked to provenance. |
| `AccountSlot` | Desired channel capacity and identity spec: platform, profile, niche/context, keywords, disclosure rules, risk policy. Durable across replacement. |
| `AccountInstance` | Actual handle/credentials reference, ownership, operator, timestamps, readiness, health, loss reason; replaceable within a slot. |
| `OperatorAssignment` | Who may act, on which account, during what period; acknowledgement and revocation. The first operator can simply be the user. |
| `WorkOrder` | Typed human task (`provision`, `warmup`, `post`, `comment`, `measure`, `replace`) with instructions, due/eligible time, priority, attempts, and approval policy. |
| `ContentRelease` | Versioned media/caption/claims/disclosures approved for distribution; immutable after release. |
| `DeliveryTarget` | One release × one account instance; ordered queue position, schedule window, idempotency key, and publication state. |
| `ProofArtifact` | Screenshot/URL/metadata submitted by an operator, reviewer decision, rejection reason, and audit timestamps. |
| `MetricSnapshot` | Time-series platform metrics tied to the delivery target and experiment. Never overwrite prior observations. |
| `CapacityLedger` | Desired/ready/impaired slot counts and task/spend budgets; triggers replacement and overprovision alerts. |

Credentials should be referenced through a secrets boundary, never embedded in MCP project context, work-order text, logs, or proof.

### Proposed MarketingOS state machines

These are recommendations, not HumanPost's undocumented internals.

**Account slot**

```text
requested → awaiting_assignment → provisioning → warming → ready → active
                                ↘ rejected/failed
ready|active → impaired → replacing → warming
ready|active → paused → active
any nonterminal → retired
```

An `AccountInstance` becomes `lost` or `retired`; the `AccountSlot` survives and points to a replacement. “Ready” must be an explicit, configurable checklist, not elapsed time alone.

**Human work order**

```text
draft → awaiting_brand_approval → queued → claimed → in_progress
     → proof_submitted → under_review → completed
                               ↘ changes_requested → queued
queued|claimed|in_progress → cancelled
claimed|in_progress → failed → queued (if attempts remain) | dead_letter
```

Use leases for `claimed` work so abandoned tasks can be reassigned. Every completion requires proof; retries create new attempts rather than rewriting history.

**Content delivery**

```text
draft → awaiting_brand_approval → approved → queued → released_to_operator
     → posting → proof_submitted → verified_posted
                          ↘ failed → retry_queued | terminal_failed
approved|queued → cancelled
```

Once released to an operator, cancellation is a request, not a guarantee. Aggregate a multi-account `ContentRelease` from its `DeliveryTarget` states (`partially_posted` is derived, not independently mutated).

### Required invariants

- Stable idempotency key per intended delivery; the same key cannot create a second target.
- No work can be claimed without an active operator assignment and account instance.
- No posting task is released without an immutable approved content version and disclosure checklist.
- Proof and review events are append-only; corrections produce a new attempt.
- Warm-up actions have per-account daily caps and randomized allowed windows, but no automation that performs the platform action.
- A lost account never silently changes identity: preserve the old instance, loss reason, and replacement link.
- Analytics are timestamped observations with source and collection method; no metric should be presented as causal proof.

## Copy, adapt, do not copy

### Copy the mechanism

- Separate durable account slots from replaceable platform-account instances.
- Turn every real-world action into an assigned, observable work order with proof and review.
- Use one queue item per account target, safe idempotent creation, scheduled eligibility, daily caps, and clear cancellation boundaries.
- Keep human execution explicit while software handles orchestration, validation, audit, and analytics.
- Feed results into named experiments so output volume produces learning rather than undifferentiated posting.

### Adapt for MarketingOS

- Populate brand/niche/instructions from each Connected Project's MCP server, while keeping social credentials and operator PII inside MarketingOS's secrets/operations boundary.
- Replace HumanPost's opaque “warmed” state with a project-owned checklist: profile complete, identity/disclosure approved, minimum observation sessions, niche interactions evidenced, platform health checked, and reviewer sign-off.
- Start with self-operation/invited collaborators and a dashboard inbox. Add a marketplace only after task volume, quality criteria, compensation, identity verification, and safety controls are validated.
- Default to manual approvals and conservative caps. Treat warming as legitimate niche familiarization and audience research, not a guarantee of reach or an enforcement-avoidance technique.

### Do not copy

- Do not depend on HumanPost, its MCP, or its workers; it is a reference only.
- Do not market “warmed” accounts as safe, permanent, or guaranteed to perform.
- Do not encode U.S.-only humans, thousands of accounts, 20–25% overprovisioning, or CPM billing as domain truths; those are HumanPost operating choices.
- Do not let an agent autonomously create identities, engage, comment, or publish without scoped authorization, human approval, audit evidence, disclosure checks, and a kill switch.
- Do not copy opaque account/job statuses. MarketingOS needs explicit transition rules, reasons, attempts, owners, and timestamps.

## Still undocumented after reviewing all public first-party pages

HumanPost's published sitemap contains the product page, legal pages, careers, and six documentation pages; no additional public operator handbook or warming specification is linked. [Official sitemap](https://humanpost.co/sitemap.xml)

The following cannot be responsibly inferred: account activation SLA/distribution; operator vetting and identity/location verification; assignment algorithm and concurrency; exact account/job/proof states; warm-up duration, action mix, caps, or readiness score; account custody/ownership and credential rotation; proof requirements and reviewer SLA; pay rates/incentives; task retry/reassignment/dead-letter rules; account loss rate and replacement SLA; analytics collection method/frequency/accuracy; fraud or collusion controls; platform-specific policy review; data deletion timelines; breach response; and how SparkCode/comment jobs work.

Those gaps should become explicit product decisions and risk gates in the MarketingOS spec, not assumptions borrowed from the landing page.
