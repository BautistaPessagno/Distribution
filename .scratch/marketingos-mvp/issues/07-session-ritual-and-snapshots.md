# 07: Session ritual and Project Snapshots

**What to build:** The host-facing project session, matching GatewaySim walkthroughs 1 and 5 from the planning prototypes. `select_project` pins an immutable snapshot; every subsequent response echoes `{project, snapshot, contract}`. Project-touching calls before selection return `no_project_selected` naming the exact next call. `get_snapshot` refreshes; `get_resource` returns brand, claims, and profile with field provenance; Context Gap states (`unsupported`, `empty`, `stale`, `invalid`, `conflicted`, `unavailable`) surface as data, not errors.

**Blocked by:** 06 Connected Project registration.

**Status:** done

- [x] Guiding error fires before selection with the corrective next call
- [x] Stale snapshots refuse reads with `stale_snapshot` and the recovery path
- [x] Switching projects mid-session re-pins and reports notes about in-flight work
- [x] Contract tests replay the GatewaySim reference transcripts

## Comments

- Implemented in PR https://github.com/BautistaPessagno/Distribution/pull/7: `server/gateway.ts` session state pins immutable snapshots per host token; `marketingos.select_project`, `project.get_snapshot`, and `project.get_resource` MCP tools echo `{project, snapshot, contract}`, return guiding `no_project_selected`/`stale_snapshot` errors, and surface Context Gap states as data. Contract tests in `tests/gateway-session.test.ts` replay GatewaySim walkthroughs 1 and 5.
