# Prototype the dashboard information architecture

Type: prototype
Status: resolved
Blocked by: 09, 10, 11, 12

## Question

What dashboard structure and first-ten-minute flow best unify Today, Strategy, Studio, Calendar, Account Operations, Learning, Resources, and Project Connection without copying The Agentcy's screen or hiding important states?

## Answer

Settled through two prototype rounds the Operator reacted to and approved.

### The verdict: a guided single-step rail

Three structurally different IAs were prototyped in [dashboard-ia.html](../prototypes/dashboard-ia.html) (A guided rail, B areas sidebar, C plan-and-act split). Variant A won, then was refined in [dashboard-guided.html](../prototypes/dashboard-guided.html) to show **only the current step**: one headline, one line of why, one artifact, one primary action. A segment mark and a mono step count are the only evidence other steps exist. Enter advances; skip is a quiet link.

### First-run onboarding is pure setup

The first-ten-minute flow is a three-step setup rail that never applies a change to a Connected Project: connect the first project (mints its service token, pins a read-only snapshot), connect the AI Host (one copyable connector instruction), create the first Account Slot. The done screen states the boundary explicitly and hands off to the daily loop.

### The daily loop

Four steps drawn from the resolved workflows: send today's brief to the AI Host (copyable prompt), review returned drafts, do the day's warm-up Work Order with proof, record due Metric Snapshots. Every step hands over exactly one copyable prompt or one plain instruction, per the map's standing preference.

### Approvals live outside the rail

Applying a change to a Connected Project is never a guided step. Digest approvals surface as their own explicit interruption showing the exact diff, matching the two-phase write contract. The rail resumes after.

### Where the eight areas went

Today IS the rail. Studio, Calendar, Operations, Learning, and Project Connection exist as destinations reachable from the header and from rail steps that reference them, not as a permanent sidebar; states stay visible through pastel status tags on every referenced object. Strategy and Resources surface through the rail's briefs and prompts rather than as browsing surfaces in the MVP.

### Visual language

The minimalist-ui protocol: warm monochrome canvas, 1px hairline separation instead of card boxes, serif step headline, mono identifiers, muted pastel status tags, off-black primary button, staggered entry motion with a reduced-motion fallback.
