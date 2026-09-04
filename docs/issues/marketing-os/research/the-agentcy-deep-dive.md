# The Agentcy as a design reference for MarketingOS

Research date: 2026-08-30. Sources are first-party pages published by The Agentcy. The product changes quickly, so the public skill is the best source for tool behavior. MarketingOS should treat The Agentcy as a design reference, not a service to call.

## Recommendation

The useful idea is the split between an AI host and a deterministic workspace. The user's existing AI account writes copy, selects a creative direction, and asks for structured changes. The app stores the brand, edits a portable document, checks it, renders it, and keeps version history. The Agentcy explicitly does not run a model or charge for tokens. Its MCP server gives the user's agent controlled access to one workspace. [Skill](https://theagentcy.app/skill) · [llms.txt](https://theagentcy.app/llms.txt) · [privacy](https://theagentcy.app/legal/privacidad)

MarketingOS should copy that division of work. It should extend it with project evidence from each Connected Project MCP, marketing strategy from the Marketing AGI reference, and HumanPost-style human Work Orders for warming and distribution. It should not depend on The Agentcy.

The MVP should produce static branded images and copy without asking for a model API key. It can prepare grounded prompts and source assets for image generation or editing inside ChatGPT, then accept the returned image as an asset. Prompt preparation is a MarketingOS feature. Invoking ChatGPT's image model is an AI-host action. Fully automated image generation inside MarketingOS would require a separate model contract and is outside this MVP.

## Dependency classification

- **A:** feasible with the user's AI account, Connected Project MCP, MarketingOS code, and local app storage.
- **B:** needs an ordinary destination account that is intrinsic to the task, such as an Instagram or ads account.
- **C:** needs another vendor service, API credential, paid product, or specialized model. Defer it.
- **D:** the first-party evidence does not settle the dependency or current behavior.

| Capability | Class | What the evidence says and what MarketingOS should do |
| --- | --- | --- |
| Connected Project context | A | The Agentcy keeps brand context in a workspace. MarketingOS should instead populate it from a versioned Connected Project MCP snapshot, with manual overrides and provenance. |
| Brand workspace | A | The brand kit has seven color roles, three font roles, logos, voice, name, product description, and publishing cadence. Website extraction is presented for approval before applying it. Brand tokens repaint existing work when the kit changes. Copy this behavior. [First-piece guide](https://theagentcy.app/guias/tu-primera-pieza) · [skill](https://theagentcy.app/skill) |
| Hooks, templates, assets, prior pieces | A | The agent can list and save hooks, reuse templates, inspect the media library, and read prior pieces. Use local assets first. [Skill](https://theagentcy.app/skill) |
| Structured social pieces and carousels | A | PieceDoc is portable, layered, tokenized, and deterministic. MarketingOS can implement static post, square, story, and wide formats locally. [Skill](https://theagentcy.app/skill) |
| Layer editor, autosave, undo, version history | A | Human and agent edit the same document. Restoring an old version creates a new version. Copy the version model, but add an explicit review state before external actions. [First-piece guide](https://theagentcy.app/guias/tu-primera-pieza) |
| Brand and quality checks | A | The product runs deterministic checks for brand consistency, broken geometry, composition, and explainable anti-slop signals. Safe repairs use compare-and-swap. This belongs in the MVP. [Skill](https://theagentcy.app/skill) |
| Preview and local export | A | The server renders the same document used by the editor. MarketingOS can render PNG files and a local preview with no model service. [First-piece guide](https://theagentcy.app/guias/tu-primera-pieza) |
| Captions and translations | A | PieceDoc stores per-network captions and language lineage. Duplication preserves layout, then the agent translates text. Copy the data model. [Skill](https://theagentcy.app/skill) |
| Content backlog and planned dates | A | An undated backlog is separate from the calendar. A planned date does not publish anything. Copy that distinction. [Skill](https://theagentcy.app/skill) · [publishing guide](https://theagentcy.app/guias/publicar) |
| Grounded image prompt | A | MarketingOS can combine project facts, brand rules, format, existing assets, and negative constraints into a prompt for the user's AI host. |
| Image generation or editing in ChatGPT, with manual return | A | The user invokes their existing AI account and returns the result by upload or attachment. MarketingOS must record `origin: ai_host` and must not claim it generated the image. |
| Automatic AI-image round trip through MCP | D | The Agentcy contract imports URLs, stock images, and local library assets. It does not document a generic way for an AI host to return generated binary media through MCP. [Skill](https://theagentcy.app/skill) |
| Stock search | C | The Agentcy uses Openverse, which is another service even though it does not need the user's credentials. Defer this and start with project assets, local upload, or AI-host output. [Skill](https://theagentcy.app/skill) · [privacy](https://theagentcy.app/legal/privacidad) |
| Direct social publishing and scheduled delivery | B | Publishing needs a professional Instagram account, account ID, and Meta token. Other networks were not connected when the guide was published. The MVP can export files and instructions instead. [Publishing guide](https://theagentcy.app/guias/publicar) · [Instagram guide](https://theagentcy.app/guias/conectar-instagram) |
| Paid-ad publishing and spend control | B | Creative briefs, copy, and exported ad images are A. Creating campaigns, spending money, or reading ad metrics needs an ads account and approval, so keep those external actions out of the first MVP. |
| Human warming Work Orders and proof | A for planning; B for execution | MarketingOS can schedule and record tasks locally. The operator needs the destination social account to perform them. Use HumanPost as the operating reference, not The Agentcy's Reach automation. |
| Reach follow and unfollow automation | B, with policy risk | Reach runs a browser-console script against the user's Instagram session. The Agentcy warns that it may breach Meta terms and cause limits, suspension, or closure. Do not copy the automation. [Reach guide](https://theagentcy.app/guias/reach) |
| Platform analytics | B | The public product records a publication permalink and Reach run counts. No first-party page documents post-performance analytics. MarketingOS can start with manual outcome entry, then add authorized platform reads later. [Publishing guide](https://theagentcy.app/guias/publicar) · [Reach guide](https://theagentcy.app/guias/reach) |
| Team seats, client approval, shared design system and calendar | D | The pricing page lists these under an Enterprise plan that is still "coming soon." Treat them as product ideas, not proven behavior. [Pricing](https://theagentcy.app/pricing) |
| Public review link | C for a hosted link | The Agentcy can expose a read-only public piece link. A local MVP can preview locally; a public link requires hosting and access controls. [First-piece guide](https://theagentcy.app/guias/tu-primera-pieza) |
| Video generation | C | A generative video needs Seedance or another specialized provider. Defer it. |
| Clip extraction and AI subtitles | C or D | Pricing calls automatic clipping and subtitles "coming soon," while another FAQ loosely says Studio includes video. There is no public MCP contract for it. Defer it. [Pricing](https://theagentcy.app/pricing) · [ChatGPT carousel guide](https://theagentcy.app/guias/carruseles-con-chatgpt) |

## The document and editing model worth copying

The Agentcy models one post as a database row plus `PieceDoc`. The row carries title, status, category, planned date, and version. The document carries a schema version, title, optional category, format, one to twenty slides, per-network captions, and metadata such as template, notes, language, and translation source. A slide has an ordered layer stack and a background. A layer has an ID, pixel frame, role, and one of six types: text, image, shape, logo, or code-drawn artifact. The published skill currently names four presets: 4:5 at 1080×1350, 1:1 at 1080×1080, 9:16 at 1080×1920, and 16:9 at 1920×1080. [Skill](https://theagentcy.app/skill)

Colors and fonts are brand-token references rather than copied values. PieceDoc contains no workspace ID, piece ID, or external URL, which makes templates portable and lets a kit update repaint old pieces. Images point to stable local asset IDs. Logo layers resolve from the brand kit. Captions cover Instagram, X, LinkedIn, and TikTok. An X caption can contain a thread and a per-post slide map. [Skill](https://theagentcy.app/skill)

The code-drawn `artifact` layer is particularly useful. It represents app windows, browsers, spreadsheets, charts, chats, prompts, receipts, notifications, comparisons, reviews, approval cards, large numeric callouts, and arrows as editable data. MarketingOS should adapt this into `EvidenceArtifact` and `ProductArtifact`, populated only with facts from the Connected Project snapshot. Fake dashboards and invented metrics must fail validation.

Editing uses fourteen typed operations for text, style, movement, z-order, layers, backgrounds, images, slides, captions, format, and metadata. A mutation sends at most twenty ordered operations with `baseVersion`. The batch is atomic. A stale version returns a conflict instead of overwriting a human save. Structural errors reject the batch. Invalid cosmetic values fall back to a default and return warnings. This is a clean MCP contract because it is bounded, retryable, and inspectable. [Skill](https://theagentcy.app/skill)

Validation has two passes. `check_brand` finds off-kit colors and fonts, overflow, small text, empty layers, missing assets, and exact color collisions. `check_quality` reports evidence-bearing findings for broken geometry, hierarchy, composition, and recognizable content-design failure modes. A bounded repair call may apply only precomputed, unambiguous fixes, then reruns checks. Warnings remain review prompts, not blockers. MarketingOS should keep this separation and never turn a heuristic score into a measured outcome.

One important change is needed. The Agentcy says agent writes appear immediately in the shared workspace, with no private agent draft or pre-write approval. That is acceptable for reversible document edits. MarketingOS also handles strategy, warming tasks, ads, and eventual publishing. It needs a staged proposal state and explicit approval for any action outside local storage. [For agents](https://theagentcy.app/for-agents) · [publishing guide](https://theagentcy.app/guias/publicar)

## AI-host and MCP boundary

MarketingOS has two MCP relationships.

1. It acts as a client of each Connected Project MCP. A sync imports facts, offers, audience, product screens, brand assets, routes, funnel events, and evidence references into an immutable `ProjectSnapshot`. Each field records its MCP source, snapshot version, and retrieval time.
2. It exposes a MarketingOS MCP server to the user's AI host. Authorization should scope a connection to one MarketingOS workspace and one selected Connected Project. The Agentcy's one-workspace OAuth grant is the useful precedent. [For agents](https://theagentcy.app/for-agents) · [skill](https://theagentcy.app/skill)

The minimum AI-host request should return a `CreativeBrief`, not a loose paragraph:

```json
{
  "projectSnapshotVersion": 12,
  "objective": "...",
  "audience": "...",
  "channel": "instagram",
  "format": "4:5",
  "evidenceRefs": ["mcp://project/..."],
  "allowedClaims": ["..."],
  "brandTokens": { "primary": "...", "display": "..." },
  "voiceRules": ["..."],
  "availableAssetIds": ["..."],
  "requiredOutput": { "slides": 6, "caption": true },
  "negativeConstraints": ["no invented metrics", "no generic CTA"]
}
```

The AI host chooses an angle, writes the narrative, and may generate or edit an image using capabilities included in that host. MarketingOS composes geometry, stores versions, checks the result, renders previews, and exports files. A returned image enters through `register_asset`, with origin, prompt, source-asset lineage, and rights notes. If the host cannot return a file to an MCP tool, the handoff stays manual. The app should say "prompt prepared" until an asset actually comes back.

Useful MCP tools for the first release are `get_project_snapshot`, `get_brand_kit`, `list_assets`, `list_hooks`, `list_pieces`, `get_piece`, `create_piece`, `update_piece`, `check_piece`, `render_preview`, `set_piece_meta`, `create_work_order`, and `record_outcome`. Mutations use `baseVersion`. Destructive actions and external actions always need an app-side confirmation.

## Smallest native MVP

1. **Project switcher and sync.** Connect KeepAnalog, partnr, and VinylOS through their MCP servers. Show snapshot age, missing facts, and source links.
2. **Brand and marketing context.** Store the tokenized brand kit, voice rules, audience, positioning, offers, proof, prohibited claims, and local asset library. The Connected Project is the source; the dashboard is the review and override layer.
3. **Backlog and studio.** Turn Marketing AGI opportunities into versioned `CreativeBrief` records, then into static posts, carousels, ad creatives, captions, and reusable templates. Keep ideas undated until the user promotes them.
4. **Deterministic editor and checks.** Implement a small PieceDoc subset first: text, image, shape, logo, four formats, captions, version history, atomic edit batches, brand checks, quality checks, preview, and PNG export. Add code-drawn artifacts after the basic renderer works.
5. **AI-host handoff.** Let ChatGPT read the grounded brief through MCP. It can write copy and, when available in the user's account, generate or edit images. MarketingOS imports results instead of owning a model API.
6. **Operations.** Create HumanPost-style warming and distribution Work Orders for the sole operator, with due date, instructions, limits, proof, review, and outcome. Do not automate follows or require social credentials.
7. **Learning.** Record manual reach, clicks, leads, signups, and notes against the piece and experiment. This keeps the learning loop useful before platform analytics integrations exist.

Defer direct publishing, social token storage, ad-spend actions, stock APIs, hosted review links, organization seats, automated approval iteration, platform analytics, video, and Reach-style automation.

## Proposed objects and states

Core objects are `ConnectedProject`, `ProjectSnapshot`, `BrandKit`, `BrandRule`, `Asset`, `Hook`, `Template`, `Opportunity`, `CreativeBrief`, `Piece`, `PieceVersion`, `PieceDoc`, `ValidationFinding`, `PlanSlot`, `WorkOrder`, `Proof`, `Experiment`, and `Outcome`. Add `SocialAccount` and `PublicationJob` only when class B integrations enter scope.

Use this state path for creative work:

```text
opportunity -> backlog -> drafting -> review -> approved -> planned
                                                |           |
                                                |           +-> exported -> measured
                                                +-> changes requested -> drafting
```

Work Orders follow `proposed -> approved -> assigned -> in_progress -> proof_submitted -> accepted`, with `blocked` and `cancelled` exits. A future publication job follows `queued -> rendering -> uploading -> publishing -> published`, with a retryable `failed` state and a saved destination permalink. Planning a date must never imply that publishing was scheduled.

## Dashboard areas

- **Today:** snapshot warnings, recommended next action, due Work Orders, pieces awaiting review, and experiments needing an outcome.
- **Strategy:** positioning, audience, evidence, opportunities, SEO and GEO work from the Marketing AGI reasoning layer.
- **Studio:** backlog, briefs, posts, ad creatives, captions, templates, assets, versions, validation, and previews.
- **Calendar:** planned pieces and human distribution tasks. It is a plan, not a hidden publishing queue.
- **Operations:** account slots, warming Work Orders, proof, limits, and account health, following the HumanPost reference.
- **Learning:** experiment hypothesis, shipped artifact, manual metrics, result, and the decision to repeat, change, or stop.
- **Project connection:** Connected Project MCP status, snapshot history, field provenance, permissions, and sync errors.

## Copy, adapt, avoid

Copy the portable tokenized document, typed edits, atomic batches, optimistic concurrency, reversible history, deterministic rendering, evidence-bearing checks, undated backlog, format-specific captions, and agent-plus-human shared workspace.

Adapt the brand workspace so MCP evidence is the source of truth. Add claim provenance, staged proposals, approval gates, experiment outcomes, and human Work Orders. Keep brand checks separate from marketing performance.

Avoid importing The Agentcy as a dependency, hiding a second model bill, pretending prompt preparation generated an image, auto-follow scripts, invented metrics inside product mockups, silent cross-project context mixing, and any state label that blurs "planned" with "scheduled to publish."

## Unresolved from first-party evidence

- `/for-agents` calls the tool set seventeen tools, while the current skill lists a larger set that includes onboarding, hooks, semantic composition, quality checks, repair, backgrounds, and Reach configuration. Treat `/skill` as current and version the MarketingOS contract. [For agents](https://theagentcy.app/for-agents) · [skill](https://theagentcy.app/skill)
- Public copy mentions a calendar and feed preview, but the publishing guide says the dedicated Calendar screen is intentionally empty and planned work currently appears on Home. Do not use the full calendar as evidence of shipped behavior. [Home](https://theagentcy.app/) · [publishing guide](https://theagentcy.app/guias/publicar)
- Enterprise collaboration and automated feedback iteration are announced but not open. [Pricing](https://theagentcy.app/pricing)
- The public sources do not document post-performance analytics, ad-network integrations, automated image generation, a binary media-return MCP contract, or a working video tool contract.
