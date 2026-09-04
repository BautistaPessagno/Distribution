# 24: Metric Snapshots

**What to build:** The two observation sources. Manual entry per Delivery Target through measure Work Orders (views, likes, comments, follows, clicks) and product-funnel reads through each project's metrics capability bundle. Every snapshot carries source, collection method, and timestamp; observations are never overwritten.

**Blocked by:** 23 Experiments and measure Work Orders.

**Status:** done

- [x] Completing a measure order records a snapshot tied to its target and experiment
- [x] Funnel reads record their project snapshot provenance
- [x] A second observation of the same metric appends; nothing updates in place
