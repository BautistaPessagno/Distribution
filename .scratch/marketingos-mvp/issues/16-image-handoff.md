# 16: Image handoff

**What to build:** The binary return path from GatewaySim walkthrough 3. `register_asset` accepts inline base64 up to the cap with required origin, prompt, source-asset lineage, and rights notes; generated assets carry `origin: ai_host`. Missing metadata fails with `rights_missing`; missing or oversized payloads drop the piece to `prompt_prepared` and point at the manual dashboard upload, which records the same lineage. MarketingOS never claims it generated an image.

**Blocked by:** 09 PieceDoc and Studio.

**Status:** done

- [x] All four register_asset outcomes (accepted, no bytes, over cap, missing origin) match the reference transcripts
- [x] Manual upload attaches the asset with lineage and clears prompt_prepared
- [x] Image layers can reference registered assets by stable ID

## Comments

- Implemented on branch `claude/16-image-handoff`. `server/assets.ts` holds `register_asset`: inline base64 up to 2MB with a required origin, a prompt required for generated assets, and rights notes recorded (defaulting to `unreviewed` with a warning that says so). The four outcomes replay GatewaySim walkthrough 3 message for message; a payload that is not actually a PNG, JPEG, or WebP is refused rather than stored, since these bytes are later served from the dashboard's own origin. No payload or an oversized one drops the piece to `prompt_prepared`, keeps the prepared prompt, and points at `POST /api/assets`, whose upload records the same lineage plus the Operator's rights confirmation and clears the state. Image layers reference assets by an immutable `asset://<id>`; the rendered markup points at the asset's URL, which the dashboard fetches over the authenticated route and the exporter serves into Chromium from the database — so preview and export stay byte-identical HTML while the MCP response stays small. An unresolvable reference is a `check_brand` **warning**, not an error, because a Creative Template keeps its refs and blocking would make every template-started piece unapprovable. Covered by `tests/assets.test.ts` (15 tests) plus export and template regression tests.
