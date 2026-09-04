# 12: Brand Kit and deterministic checks

**What to build:** Tokenized brand behavior. Pieces reference Brand Kit tokens, never copied values; a kit change repaints backlog and drafting pieces live in the preview. `check_brand` reports off-kit colors and fonts, empty text layers, and overflow as errors and warnings; `check_quality` reports advisory heuristic findings. Both render in Studio and are callable by the host.

**Blocked by:** 11 Deterministic renderer and PNG export.

**Status:** done

- [x] Changing a kit token visibly repaints a drafting piece without touching its stored document
- [x] An off-kit raw color yields a check_brand error naming the layer
- [x] Quality findings are visibly labeled advisory

## Comments

- Implemented on branch `claude/12-brand-kit-and-checks`. `server/brand-kit.ts` holds a per-project, append-only versioned token table (`brand.<name>` colors, `font.<name>` families) seeded lazily at v1; `render/piece-slide.tsx` takes that table as a render-time input, so a kit change repaints backlog and drafting pieces with no document change. `server/checks.ts` is the two deterministic passes: `check_brand` errors on off-kit colors and fonts, empty text layers, and missing assets and warns on overflow, each finding naming its slide and layer; `check_quality` findings are all `severity: "advisory"` with `blocksApproval: false`. Host tools `marketingos.get_brand_kit`, `check_brand`, `check_quality`; Operator surfaces `/api/brand-kits` and `/api/pieces/:id/checks`, both rendered in Studio. Covered by `tests/brand-kit.test.ts` (17 tests). Pinning the kit at approval and the brand-outdated flag are ticket 13.
