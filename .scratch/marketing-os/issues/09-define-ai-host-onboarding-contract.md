# Define the AI Host onboarding contract

Type: prototype
Status: resolved
Blocked by: 10

## Question

What authentication scope, onboarding guide, Method Library discovery, two-domain resource and tool catalog, examples, and image-result handoff must the single MarketingOS MCP gateway expose so an AI Host can understand and safely operate one selected Connected Project?

## Answer

Settled through grilling and validated in an interactive session simulator the Operator approved: [ai-host-onboarding.html](../prototypes/ai-host-onboarding.html). Its pure `GatewaySim` module is the liftable reference for the contract's behavior; the transcript view doubles as the golden examples.

### Authentication scope

One connection per AI Host, scoped to the MarketingOS workspace. The Connected Project is selected in-session through `marketingos.select_project`, and every response echoes `{ project, snapshot, contract }` so cross-project mixing stays visible. No per-project connections and no per-project API keys.

### Session ritual

Enforced with guiding errors. Until `select_project` succeeds, every project-touching tool returns `no_project_selected` with the exact next call to make. Onboarding is recommended but not forced: a session that skips `marketingos.onboard` gets a warning on responses, not a lockout.

### Onboarding guide and Method Library discovery

`marketingos.onboard` returns a compact versioned guide: contract version, Method Library version, the start-here ritual, the safety rules (host provides all AI compute, two-phase writes, no cross-project mixing, image lineage requirements), the tool map, and the example goals. Discovery is progressive: `marketingos.get_method(goal)` returns only the method, rubric, steps, and output schema the current goal needs. An unknown goal returns `unknown_goal` with the closest goals as routing suggestions. No catalog dump, no giant prompt.

### Two-domain tool catalog (v1, 19 tools)

- `marketingos.*`: onboard, select_project, get_method, list_hooks, list_pieces, get_piece, create_piece, update_piece, check_piece, render_preview, set_piece_meta, register_asset, create_work_order, record_outcome, get_approval
- `project.*`: get_snapshot, get_resource, prepare_change, apply_change

Piece editing follows the Creative Piece workflow: atomic batches, `baseVersion`, `version_conflict` on stale writes.

### Examples

Three golden goals ship in the Method Library and are exercised by the simulator's walkthroughs: `draft_creative_piece`, `generate_image`, and `propose_project_write`. Each pairs steps with a typed output schema.

### Approval transit

Digest-keyed and gateway-internal. `project.prepare_change` returns a digest and the exact diff; the Operator approves that digest in the dashboard; the host polls `marketingos.get_approval(digest)` and then calls `project.apply_change(digest)` exactly once. No grant token ever transits the host. Approvals are single-use, bound to their project and prepared revision: a second apply, a cross-project apply, or an apply after an upstream project change all refuse with a structured error naming the recovery path.

### Image-result handoff (closes the binary-return fog item)

`marketingos.register_asset` accepts an inline base64 payload up to 2 MB with required `origin`, prompt, source-asset lineage, and rights notes; generated assets must carry `origin: ai_host`. Missing metadata fails with `rights_missing`. If the host cannot send binary payloads or the file exceeds the cap, the piece drops to `prompt_prepared` and the Operator uploads manually in the dashboard, which records the same lineage. MarketingOS never claims it generated the image.

### Operator experience note

Per the standing minimalist preference on the map: the product's workflow surfaces stay step-by-step, and each step hands the Operator exactly one copyable prompt for the AI Host or one plain instruction to perform. The gateway's guiding errors already carry the "next call" for the host side; the dashboard mirrors that with a single next action for the human side.
