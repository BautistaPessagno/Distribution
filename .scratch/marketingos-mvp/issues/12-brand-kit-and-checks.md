# 12: Brand Kit and deterministic checks

**What to build:** Tokenized brand behavior. Pieces reference Brand Kit tokens, never copied values; a kit change repaints backlog and drafting pieces live in the preview. `check_brand` reports off-kit colors and fonts, empty text layers, and overflow as errors and warnings; `check_quality` reports advisory heuristic findings. Both render in Studio and are callable by the host.

**Blocked by:** 11 Deterministic renderer and PNG export.

**Status:** ready-for-agent

- [ ] Changing a kit token visibly repaints a drafting piece without touching its stored document
- [ ] An off-kit raw color yields a check_brand error naming the layer
- [ ] Quality findings are visibly labeled advisory
