# 16: Image handoff

**What to build:** The binary return path from GatewaySim walkthrough 3. `register_asset` accepts inline base64 up to the cap with required origin, prompt, source-asset lineage, and rights notes; generated assets carry `origin: ai_host`. Missing metadata fails with `rights_missing`; missing or oversized payloads drop the piece to `prompt_prepared` and point at the manual dashboard upload, which records the same lineage. MarketingOS never claims it generated an image.

**Blocked by:** 09 PieceDoc and Studio.

**Status:** ready-for-agent

- [ ] All four register_asset outcomes (accepted, no bytes, over cap, missing origin) match the reference transcripts
- [ ] Manual upload attaches the asset with lineage and clears prompt_prepared
- [ ] Image layers can reference registered assets by stable ID
