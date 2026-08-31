# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root
- `CONTEXT-MAP.md` at the repo root, if it exists. It points to one `CONTEXT.md` per context. Read each file relevant to the topic.
- Relevant ADRs under `docs/adr/`
- In multi-context repos, relevant ADRs under `src/<context>/docs/adr/`

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill, reached through `/grill-with-docs` and `/improve-codebase-architecture`, creates them when terms or decisions get resolved.

## File structure

This repo uses the single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Do not replace it with synonyms that the glossary explicitly avoids.

If a required concept is missing from the glossary, reconsider whether the project uses that language. If the gap is real, record it for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, report the conflict instead of silently overriding the decision:

> Contradicts ADR-0007, which specifies event-sourced orders. Reconsider that decision before proceeding.
