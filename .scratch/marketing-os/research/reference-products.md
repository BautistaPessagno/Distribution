# Reference-product research for MarketingOS

Date: 2026-08-30

## Scope and evidence

This note examines four first-party references for a MarketingOS that its builder can use across Scroll a Papel, Partnr, and VinylOS. The intended outcome is better distribution, traction, SEO, GEO, and day-to-day marketing execution.

I used the Marketing AGI repository and source files, The Agentcy's public product pages and raw agent skill, Maxfusion's product and pricing pages, HumanPost's product and API documentation, and X's official oEmbed response for the supplied post. Product-page statements are vendor claims unless the linked source exposes the mechanism or data. I found no independent performance evidence in the supplied sources.

## The useful split

These references do different jobs. Treating them as four competing all-in-one products would produce a muddled MVP.

| Reference | Actual role | Useful idea for MarketingOS | What not to copy into the MVP |
| --- | --- | --- | --- |
| Marketing AGI | Marketing reasoning and artifact-generation playbooks | A thin router, persistent brand context, evidence labels, and task-specific modules | Fourteen modules at launch, heuristic scores presented as truth |
| The Agentcy | Brand-aware, agent-operated social design workspace | Structured editable artifacts, brand tokens, deterministic checks, explicit versions | A full visual editor and direct publishing before the core loop works |
| Maxfusion | High-volume paid-ad research and media production | Research-to-brief-to-production handoffs and replaceable specialist tools | Expensive video-generation infrastructure or a model marketplace |
| HumanPost | Human-operated TikTok and Instagram distribution | A distribution-job state machine, per-target queues, proofs, retries, and outcome collection | Account-farm distribution as the default growth strategy |

The strongest product direction is a control layer over this stack. MarketingOS should hold each project's strategy, evidence, plan, artifacts, approvals, distribution records, and learning. Specialist systems can plug into it later.

## Marketing AGI

### What it actually does

Marketing AGI is an MIT-licensed Markdown skill, not an autonomous service. A roughly 2,000-token router loads one or more task modules for audits, GEO, copy, hooks, paid ads, email, social, launches, positioning, competitive work, app stores, and analytics. It contains no executable code. Its repository explicitly describes progressive loading and optional subagent fan-out for multidimensional work. ([README](https://github.com/holy-templar/marketing-agi/blob/main/README.md), [skill router](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/SKILL.md))

Its target user is a marketer or founder working through Claude, Codex, Cursor, or another agent host. The user adds one `brand-context.md` file containing the product, audience, positioning, proof, voice, and constraints. Every module reads that shared context. ([brand-context template](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/brand-context.template.md))

The workflow is request-driven:

1. Read brand context.
2. Route the request to a narrow module.
3. Gather the available public pages or supplied data.
4. Produce a concrete artifact such as replacement copy, an audit, a production brief, or JSON-LD.
5. State evidence limits and unresolved gaps.
6. Chain the result into a later module without repeating the research.

This is a prompt architecture. Its only named production integration is an optional ad-generation MCP such as Maxfusion, used after the paid-ad module has produced a brief. It does not connect to analytics, search, email, or social systems by itself. ([skill router and chaining rules](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/SKILL.md))

### Measurement and feedback

The audit module scores six dimensions with fixed weights, then orders fixes by impact and effort. The repository labels those scores as marketing heuristics rather than measured performance. ([audit workflow](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/references/audit.md))

The analytics module is more valuable than the scores. It requires an evidence level, sample, observation window, defensible claim, unsupported claim, and cheapest next observation. It also asks users to define the test variable, primary metric, decision rule, sample target, and stop condition before launch. ([analytics module](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/references/analytics.md))

The paid-ad module classifies ads by the argument each ad makes, not by file or format. It separates creative fatigue from audience exhaustion, auction pressure, landing-page decay, tracking loss, and low-volume noise. Its output is a ranked production brief with a stated hypothesis and comparison metric. ([paid-ads module](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/references/paid-ads.md))

The GEO module starts with questions a user asks an answer engine, then evaluates extractability, specificity and evidence, entity clarity, corroboration, and technical access. This connects GEO work to publishable page changes rather than a generic keyword list. ([GEO module](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/references/geo.md))

### Reusable patterns

- Put one canonical brand and proof dossier behind every task.
- Load only the method needed for the current job.
- Save outputs as durable artifacts instead of leaving them in chat.
- Carry source evidence and uncertainty into downstream work.
- Make every recommendation end in a concrete edit, test, or production brief.
- Separate observed performance from a heuristic quality score.

### Limits and risks

- The skill can recommend and write, but it has no persistent campaign state, approvals, scheduled jobs, or automatic result ingestion.
- Many platform statements inside social, search, and app-store modules are playbook claims. The skill itself warns that time-sensitive platform behavior must be rechecked before use. ([honesty rules](https://github.com/holy-templar/marketing-agi/blob/main/skills/marketing-agi/SKILL.md))
- Scores create useful prioritization but can also create false confidence. MarketingOS should store the rubric version and basis beside every score.
- A broad trigger such as "any marketing task" can hide distinct workflows. MarketingOS needs explicit objects and states, not only a larger prompt.

## The Agentcy

### What it actually does

The Agentcy is a design workspace operated by a user's existing AI agent over Streamable HTTP MCP. The product does not run its own model. It stores the brand kit, templates, media, editable social pieces, calendar metadata, and publishing connection. The agent reads and changes that workspace; the person reviews the result in the app. ([agent overview](https://theagentcy.app/for-agents), [machine-readable product facts](https://theagentcy.app/llms.txt))

Its intended user is a creator, founder, small business, or agency that already uses an agent and wants branded social assets without composing each design manually. The public pricing page currently lists a free plan with up to 20 monthly downloads and a USD 10 monthly Studio plan with unlimited downloads and direct Instagram publishing. The multi-user Enterprise offer remains a waitlist. ([pricing](https://theagentcy.app/pricing))

The core artifact is a portable `PieceDoc`. A piece has a format, ordered slides, layers, per-network captions, and translation metadata. Colors and fonts refer to brand tokens rather than resolved values, so a brand-kit change can repaint existing work. The document uses stable slide and layer IDs for edits. ([raw agent skill](https://theagentcy.app/skill))

The normal agent workflow is concrete:

1. Read the brand kit and voice.
2. Choose a design direction.
3. Compose a semantic piece.
4. Apply a bounded batch of edits.
5. Run deterministic brand and quality checks.
6. Render a preview.
7. Put the piece in the backlog or on the calendar.
8. Let the person download or publish it.

Edits use optimistic concurrency through `baseVersion`; a stale agent write is rejected if the user changed the canvas meanwhile. Up to 20 operations form one atomic batch. Deterministic checks return stable codes, evidence, and suggested repairs. ([raw agent skill](https://theagentcy.app/skill), [public tool summary](https://theagentcy.app/for-agents))

Instagram is the only currently documented direct publishing destination. X, LinkedIn, TikTok, and YouTube copy or formats can live in the piece, but the documented path for them is manual export. Publishing to Instagram requires a professional account and uses a user-supplied Meta token. ([publishing guide](https://theagentcy.app/guias/publicar), [machine-readable product limits](https://theagentcy.app/llms.txt))

### Reusable patterns

- Store marketing outputs as typed, editable documents, not opaque model responses.
- Resolve brand choices through tokens and keep voice as explicit user-authored context.
- Give every mutable artifact a version and make agent writes atomic.
- Split generative judgment from deterministic validation.
- Treat preview, review, and publish as different steps.
- Keep channel-specific copy attached to the source artifact.

### Limits and risks

- The Agentcy handles content creation and scheduling, not market research, SEO/GEO planning, funnel work, or causal performance analysis.
- The public pages and raw skill differ in tool counts and some connection wording, which suggests the product changes quickly. MarketingOS should version connector capabilities instead of embedding them in prompts.
- Writes appear immediately in the workspace. That is fine for drafts, but external publication and destructive actions need a separate human approval gate.
- Its optional Reach feature automates Instagram follows in a browser. The Agentcy's own skill warns that the behavior may violate Meta's terms and can cause limits, suspension, or account closure. ([raw agent skill](https://theagentcy.app/skill))

## Maxfusion

### What it actually does

Maxfusion positions itself as an ad-creative production system for brands, media buyers, and agencies. Its MaxFlows canvas joins competitor research, TikTok trend discovery, concept work, image and video generation, and final composition. It also exposes the platform through an MCP endpoint for Claude, ChatGPT, Cursor, and other compatible agents. ([product page](https://maxfusion.ai/), [MCP connection page](https://maxfusion.ai/mcp))

The first-party pages document these production capabilities:

- Search Meta Ad Library and TikTok material inside the workspace.
- Analyze and transcribe a reference ad and extract key frames through CopyLab.
- Generate image and video assets through multiple third-party models and Maxfusion's RIZZ actor model.
- Transform media with captioning, background removal, actor replacement, voice cloning, and lip-sync tools.
- Assemble final ads in a compositor or reusable node flow. ([product page](https://maxfusion.ai/), [CopyLab](https://maxfusion.ai/copylab))

The MCP endpoint is public, but I found no public tool schema or result-state documentation. The site claims that an agent can operate the full platform; that remains a vendor claim without an inspectable catalog in the public pages. ([MCP page](https://maxfusion.ai/mcp))

Current monthly plans start at USD 99 for 2,000 credits. The pricing page lists the creative canvas, model access, processing tools, competitor-ad analysis, MCP, API access, Meta ad research, and TikTok research among plan capabilities. Exact output varies by model and credit cost. ([pricing](https://maxfusion.ai/pricing))

### Measurement and feedback

Maxfusion exposes research inputs and production volume, but its public material does not document closed-loop ingestion of spend, conversion, CAC, ROAS, or experiment assignments. "Winning ads," 10x output, daily shipment counts, and similar numbers are Maxfusion's own marketing claims and testimonials, not a described measurement system. ([product page](https://maxfusion.ai/))

### Reusable patterns

- Preserve the chain from observed competitor or trend evidence to concept, brief, generated assets, and final export.
- Make media tools replaceable nodes rather than coupling the workflow to one model.
- Keep a reusable recipe for transformations that will recur.
- Pass a production-ready brief into creative generation instead of prompting from scratch.

### Limits and risks

- The tool is optimized for paid-ad media output, not the whole marketing function.
- Model choice, credits, media storage, and long-running generation would add cost and operational complexity before MarketingOS proves its planning loop.
- A high volume of variants is not learning unless each asset has a hypothesis, audience, channel, and outcome record.
- Reference-ad cloning and synthetic actors raise copyright, likeness, consent, disclosure, and brand-trust questions. Maxfusion's product page describing "copyright-free lookalikes" is a vendor claim, not a legal determination. ([CopyLab](https://maxfusion.ai/copylab), [Banana Clone](https://maxfusion.ai/banana-clone))

## HumanPost and the referenced X launch post

### What they actually do

The supplied X post is a HumanPost launch announcement dated August 28, 2026. X's official oEmbed response identifies Mehak Vohra as the author and describes dedicated US-operated, niche-warmed social accounts for companies. The direct X page was inaccessible to the browser, so only the text returned by X's oEmbed endpoint could be verified. ([referenced X post](https://x.com/itsmehakvohra/status/2093448950384820647), [X oEmbed endpoint](https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2Fitsmehakvohra%2Fstatus%2F2093448950384820647))

HumanPost is a human-executed posting network. Customers define TikTok or Instagram account profiles, provide niche terms for account warm-up, upload finished media, and queue posts. HumanPost assigns US-based operators to create, warm, and post from the accounts. It explicitly says it does not create the content and that posters have no creative control. ([product and FAQ](https://humanpost.co/))

The public v2 API and MCP expose a well-defined operational model:

- Uploads import or receive media.
- A post combines media, captions, hashtags, sound instructions, target accounts, and optional schedule.
- Each target account gets its own queue item.
- The lifecycle moves through `draft`, `pending_approval`, `queued`, `posting`, and `posted`, with partial, failed, processing, and cancelled states.
- Post analytics return views, likes, comments, shares, saves, engagement rate, and historical collections.
- Idempotency keys prevent a retry from creating a duplicate post. ([introduction](https://humanpost.co/docs), [quickstart](https://humanpost.co/docs/quickstart), [API reference](https://humanpost.co/docs/api), [MCP catalog](https://humanpost.co/docs/mcp))

HumanPost's current entry plan is USD 180 per month plus a prepaid view balance, with performance pricing and up to five accounts. Its higher plan uses flat-rate volume. The advertised average CPM and number of available humans are first-party claims. ([pricing](https://humanpost.co/))

### Reusable patterns

- Model distribution as jobs with target-specific state, not a boolean `published` field.
- Separate the content object from the delivery attempts.
- Use idempotency for any external action that may be retried.
- Collect proofs, permalinks, failures, and metric snapshots for every target.
- Make agent permissions granular by operation.

### Limits and risks

- HumanPost solves social distribution only after another system makes the content.
- Account slots are not permanent. HumanPost tells customers to provision 20 to 25 percent more slots than needed because accounts can be lost or replaced. ([API introduction](https://humanpost.co/docs))
- **Inference:** operating many warmed accounts for one brand can create platform-policy, authenticity, reputational, and measurement risks. MarketingOS should support HumanPost only as an optional adapter, never as the assumed acquisition method.
- Platform engagement metrics alone do not connect a post to qualified traffic, activation, revenue, or retention. MarketingOS must own that join.

## What this means for the MVP

### Product boundary

Build a personal marketing control room for multiple projects. Do not build an image model, a social-account labor network, or fourteen shallow assistants.

The MVP should answer one recurring question: **What is the best defensible marketing action for this project now, can the system produce the artifact, and did the action change the intended outcome?**

### Core loop

```text
project context
  -> evidence inbox
  -> opportunity and hypothesis
  -> campaign or experiment
  -> artifact and channel variant
  -> human review
  -> export or distribution job
  -> outcome snapshots
  -> decision and reusable learning
```

This loop combines the strongest verified pattern from each reference: Marketing AGI's evidence-aware methods, The Agentcy's typed and reviewable artifacts, Maxfusion's production handoff, and HumanPost's target-specific delivery state.

### Minimum domain model

- `Project`: one of Scroll a Papel, Partnr, VinylOS, or a later project.
- `BrandProfile`: product, audience, positioning, claims and sources, voice, visual tokens, constraints, target questions, and baseline metrics.
- `Evidence`: a source, observation date, excerpt or structured value, confidence, and project scope.
- `Opportunity`: a diagnosed problem or opening, linked to evidence.
- `Experiment`: hypothesis, one primary metric, decision rule, window, status, and result.
- `Artifact`: a typed document such as a page brief, SEO/GEO change, post, carousel spec, email, or ad brief, with version and approval state.
- `ChannelVariant`: channel-specific copy, media, CTA, tracking URL, and constraints attached to an artifact.
- `DistributionJob`: adapter, targets, schedule, per-target state, attempts, permalink, proof, and error.
- `MetricSnapshot`: source, entity, metric, value, window, attribution setting, and collected time.
- `Learning`: the supported conclusion, unsupported conclusion, decision, and next observation.

### MVP workflows

1. **Onboard a project from its repo and public site.** Produce a reviewable BrandProfile, source every claim, and require confirmation before it becomes canonical.
2. **Run a weekly opportunity review.** Inspect available site, search, product, and channel evidence. Rank a small number of opportunities by expected impact, effort, confidence, and fit with the project's current goal.
3. **Create one campaign or experiment.** Predeclare the audience, message, channel, artifact, primary metric, decision rule, and end date.
4. **Produce the artifact.** Start with repo-native page or SEO/GEO briefs and text-led organic social. Store versions and source evidence. Hand rich media to an external tool only when it is necessary.
5. **Review before external action.** Draft writes can be automatic. Publishing, spending money, changing production pages, or invoking distribution services requires explicit approval.
6. **Record delivery and outcomes.** Manual publication is acceptable in the MVP if the system captures the URL and later metric snapshots. The learning record matters more than automatic posting.

### Sensible first adapters

- Local repository and website reader for project context and implementation-ready site changes.
- Manual CSV or structured import for analytics until real data sources are chosen.
- Export packages for social channels, containing copy, media brief, CTA, and tracking metadata.
- Optional MCP adapters for The Agentcy or Maxfusion behind one `creative_producer` interface.
- Optional HumanPost adapter behind one `distribution_provider` interface, disabled by default.

### Acceptance test for the dogfood MVP

The system is useful when its owner can onboard all three projects without mixing their claims or voice, select one evidence-backed opportunity per project, produce and approve a concrete artifact, record where it shipped, and return later to a result that says what the data supports, what it does not support, and what to do next.

## Unresolved questions

- Which outcome matters first for each project: qualified visits, signup or install, activation, purchase, or retained use?
- Which analytics and search data already exist for the three projects, and at what granularity?
- Should MarketingOS edit sibling repositories directly, create patches, or only write implementation briefs?
- Which social identities and channels are already active for each project?
- Is paid acquisition in the initial scope, or should the first version focus on owned pages, SEO/GEO, and organic distribution?
- Does the owner want one central MarketingOS database or project-local Markdown records with a shared dashboard?
- What external action always requires approval, and what draft work may run unattended?

