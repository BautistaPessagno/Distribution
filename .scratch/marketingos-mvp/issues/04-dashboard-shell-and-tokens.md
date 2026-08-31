# 04: Dashboard shell and design tokens

**What to build:** The minimalist-ui foundation the whole product renders in: warm monochrome canvas, hairline separation, serif step headline style, mono identifiers, muted pastel status tags, off-black primary action, reduced-motion fallback. The authenticated shell shows the project switcher, the empty guided-rail state, and empty states for Studio, Calendar, Operations, Learning, and Project Connection destinations.

**Blocked by:** 03 Operator passkey login.

**Status:** done

- [x] Design tokens exist as one source of truth; no component carries ad-hoc colors
- [x] Every destination has a composed empty state saying how it gets populated
- [x] The rail's empty state points at setup as the next action

## Comments

- Implemented design tokens in app/globals.css (warm monochrome, hairlines, serif step headlines, mono identifiers, pastel tags, off-black action, reduced-motion fallback) and the authenticated shell with project switcher and composed empty states for Rail, Studio, Calendar, Operations, Learning, and Project Connection. PR: https://github.com/BautistaPessagno/Distribution/pull/4
