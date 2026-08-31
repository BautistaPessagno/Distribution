# 04: Dashboard shell and design tokens

**What to build:** The minimalist-ui foundation the whole product renders in: warm monochrome canvas, hairline separation, serif step headline style, mono identifiers, muted pastel status tags, off-black primary action, reduced-motion fallback. The authenticated shell shows the project switcher, the empty guided-rail state, and empty states for Studio, Calendar, Operations, Learning, and Project Connection destinations.

**Blocked by:** 03 Operator passkey login.

**Status:** ready-for-agent

- [ ] Design tokens exist as one source of truth; no component carries ad-hoc colors
- [ ] Every destination has a composed empty state saying how it gets populated
- [ ] The rail's empty state points at setup as the next action
