# Define the dogfood rollout

Type: grilling
Status: claimed
Blocked by: 10, 11, 12, 13, 14, 15

## Question

In what order should KeepAnalog, partnr, and VinylOS be onboarded, which real campaign or operating loop should each test, and what observable result proves that the MVP is useful enough to keep using?

## Answer

### Order: KeepAnalog first, product stays project-agnostic

The MVP validates on KeepAnalog alone; partnr and VinylOS onboard later. The binding constraint is that nothing in the build may be KeepAnalog-specific: every capability works through the `project.*` contract and the shared SDK, no hardcoded project identity, vocabulary, or assets anywhere. The proof of agnosticism is mechanical: onboarding partnr later must require zero code changes, only the setup rail (connect project, connect host, create slot).

### The loop under test: one loop, one platform

KeepAnalog runs the full identical loop the later projects will inherit: positioning and audit artifacts, one predeclared Experiment, a cadence of Creative Pieces, one warmed Account Slot on one platform chosen for its audience, hand distribution with proof, Metric Snapshots at the observation points, and a concluded decision record. One platform keeps caps and disclosure simple; the loop is the thing under test, not reach.

### Proof of value: full loop, every gate, kept habit

The MVP passes when:

1. KeepAnalog completes at least one full loop, brief to measured decision record, with every gate exercised at least once along the way: a digest approval, a brand-error block, a `[NEED]` claim block, a cap hit, a submitted proof, a scheduled Metric Snapshot, a concluded Experiment.
2. The habit holds: the Operator still opens the daily rail in week four without forcing it.
3. Project-agnosticism is demonstrated when the second project onboards with zero code changes; the three-loop criterion (one full loop per project) completes as partnr and VinylOS come online after the MVP gate.

No outcome-based lift criterion: ticket 13's honesty rules forbid claiming causal lifts the sample sizes cannot support.
