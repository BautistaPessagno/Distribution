# 08: Method Library and goal routing

**What to build:** The versioned Method Library with initial content for the six capabilities (positioning, audit, copy, hooks, social, experiments), each with steps, rubric, and output schema. `get_method(goal)` returns exactly one method; unknown goals return `unknown_goal` with closest-goal suggestions. Chains of two or more modules return a persisted MarketingRunPlan the Operator can inspect before generation.

**Blocked by:** 05 AI Host OAuth connections.

**Status:** in-progress

- [ ] Each of the six capabilities has a versioned method a host can retrieve by goal
- [ ] Unknown goals route instead of failing
- [ ] A chained goal produces a stored RunPlan naming modules, evidence inputs, expected artifacts, and approval gates
