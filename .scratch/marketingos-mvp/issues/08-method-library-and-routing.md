# 08: Method Library and goal routing

**What to build:** The versioned Method Library with initial content for the six capabilities (positioning, audit, copy, hooks, social, experiments), each with steps, rubric, and output schema. `get_method(goal)` returns exactly one method; unknown goals return `unknown_goal` with closest-goal suggestions. Chains of two or more modules return a persisted MarketingRunPlan the Operator can inspect before generation.

**Blocked by:** 05 AI Host OAuth connections.

**Status:** done

- [x] Each of the six capabilities has a versioned method a host can retrieve by goal
- [x] Unknown goals route instead of failing
- [x] A chained goal produces a stored RunPlan naming modules, evidence inputs, expected artifacts, and approval gates

## Comments

- Implemented the versioned Method Library (`server/methods.ts`): six methods (positioning, audit_website, draft_copy, hook_matrix, social_content, design_experiment) each with steps, rubric, evidence inputs, expected artifact, approval gates, and output schema. `marketingos.get_method(goal)` is exposed through the MCP gateway; unknown goals return `unknown_goal` with closest-goal suggestions; chained goals (audit_to_copy, positioning_to_social, hooks_to_copy) persist a MarketingRunPlan in the new `run_plans` table, inspectable by the Operator at `/api/run-plans`. PR: https://github.com/BautistaPessagno/Distribution/pull/8
