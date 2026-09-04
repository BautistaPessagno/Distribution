# 14: Lifecycle completion

**What to build:** The rest of the route: Content Backlog (undated), calendar with planned dates (a plan, never a publishing queue), export from planned producing the bundle, exported and measured states, brand-outdated blocking export until re-approval. Backlog and calendar render in the dashboard per the ticket 07 Today-view decision.

**Blocked by:** 11 Deterministic renderer and PNG export, 13 Review and approval gate.

**Status:** done

- [x] Only approved pieces accept a planned date; only planned pieces export
- [x] Export refuses while brand-outdated, naming re-approval as the path
- [x] Backlog and calendar reflect state changes immediately

## Comments

- Implemented on branch `claude/14-lifecycle-completion`. Plan and unplan live in `server/piece-lifecycle.ts`: only an approved piece takes a date, the date must be a real calendar day, and unplanning returns the piece to approved and undated with its approval intact. `exportRefusal` is the single place export is allowed or not — only from planned, and never while brand-outdated, where the refusal names re-approval as the path; export then moves the piece to exported and renders through the kit its approval pinned, and `record_outcome` moves it to measured. The Content Backlog is every undated piece and the calendar every dated one, both reading the same table, so a lifecycle move shows in both at once; they render on the Today view and on the calendar page, with the Operator moves the server says apply. Covered by `tests/lifecycle-completion.test.ts` (14 tests), including walkthrough 5's illegal moves and walkthrough 4's export block and re-approval. The guided rail that orders the day's work is ticket 27.
