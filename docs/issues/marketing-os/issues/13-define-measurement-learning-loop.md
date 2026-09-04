# Define the measurement and learning loop

Type: grilling
Status: resolved
Blocked by: 11, 12

## Question

How should MarketingOS connect opportunities, hypotheses, Creative Pieces, Work Orders, Delivery Targets, and project-specific funnel observations so it can distinguish heuristic judgment from measured learning and recommend the next defensible action?

## Answer

### Observations: two sources, both timestamped

Metric Snapshots come from exactly two places in the MVP. The Operator enters social metrics by hand per Delivery Target (views, likes, comments, follows, clicks), driven by `measure` Work Orders. Product-funnel observations (signups, activations) are read from each Connected Project's metrics capability bundle through `project.*`. Every snapshot carries source, collection method, and timestamp; prior observations are never overwritten. No platform analytics APIs and no search-console ingestion in the MVP.

### Cadence: experiment-driven

Each Experiment's predeclared observation points (for example 48 hours and 7 days after `verified_posted`, and at the stop condition) auto-generate `measure` Work Orders on the Today view. Each one tells the Operator exactly which numbers to fetch from where, honoring the one-instruction-per-step preference. Ad-hoc snapshots are allowed but marked unscheduled so they cannot quietly satisfy a sample target.

### Conclusion: decision record plus learning log

An Experiment concludes only at its stop condition, with a typed decision record: repeat, change, or stop, plus an EvidenceAssessment stating what the evidence can and cannot support and the cheapest next observation. Concluded records append to a per-project learning log the AI Host reads through the gateway, so the next Creative Brief starts from measured learning instead of re-reasoning from scratch.

### Attribution: ladder-labeled, correlation by default

Every conclusion carries its evidence-ladder rung, from controlled experiment down to anecdote. Funnel movements are reported as correlated observations unless the experiment design isolated one variable. The recommend-next-action engine may cite correlations as reasons to test, never as proof, extending ticket 11's enforced honesty invariants into the loop that closes it.

### The connected chain

Opportunity -> hypothesis (Experiment, predeclared) -> Creative Pieces -> Content Release -> Delivery Targets -> measure Work Orders -> Metric Snapshots (+ project funnel reads) -> EvidenceAssessment -> decision record -> learning log -> next opportunity. Artifact lineage from ticket 11 makes each link an identifier, so the Today view can always name the next defensible action and why.
