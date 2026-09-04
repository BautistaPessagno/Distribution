# 23: Experiments and measure Work Orders

**What to build:** Predeclared Experiments: one variable, one primary metric, decision rule, sample target, stop condition, all set before work ships. Each experiment's observation points auto-generate measure Work Orders when its Delivery Targets hit verified_posted, telling the Operator exactly which numbers to fetch from where. Ad-hoc measurement stays possible but marked unscheduled.

**Blocked by:** 22 Distribution deliveries.

**Status:** done

- [x] An experiment cannot be created without its full predeclaration
- [x] Observation points generate measure orders at the right moments without manual scheduling
- [x] Unscheduled snapshots are visibly distinct from scheduled ones
