# 15: Creative Templates

**What to build:** Strip-and-save templates. Saving a piece as a Creative Template copies the PieceDoc, strips campaign text, claims, captions, and planning data, keeps layout and token references. Templates are listable and instantiable as new pieces.

**Blocked by:** 14 Lifecycle completion.

**Status:** done

- [x] A saved template contains no campaign-specific text, claims, captions, or dates
- [x] Instantiating a template creates a fresh backlog piece with the layout intact

## Comments

- Implemented on branch `claude/15-creative-templates`. `server/templates.ts` holds the strip: every field a campaign writes prose into is emptied — text layer copy (where the claims and any `[NEED: ...]` tokens live), image alt text, and all four captions — while the format, slides, layer order and types, every frame, and every Brand Kit token reference survive whole. Planning data is never copied at all: a template holds a document, not a piece, so it has no status, date, approval, history, or outcome. Instantiating creates a fresh backlog piece at version 1 with the layout intact, bound to the snapshot pinned on the instantiating session rather than the one the template came from. Templates are project-scoped like pieces; cross-project saves and instantiations are refused by name. Host tools `save_as_template`, `list_templates`, `instantiate_template`; Operator surface `/api/pieces/:id/save-as-template` and the read-only `/api/templates`, both rendered in Studio. Covered by `tests/templates.test.ts` (9 tests). An image layer keeps its `ref` so the template still renders as the composition it was — asset lineage that would let a template carry or re-resolve its images is ticket 16.
