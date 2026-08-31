# 13: Review and approval gate

**What to build:** The lifecycle gate. Drafting to review to approved with changes-requested looping back; check_brand errors and unsupported-claim `[NEED]` tokens block approval; quality findings never block. Approval pins the current kit version; a later kit change flags the piece brand-outdated; re-approval re-pins without disturbing status. Reopen clears approval and planned date.

**Blocked by:** 12 Brand Kit and deterministic checks.

**Status:** in-progress

- [ ] Approval is refused while a brand error or [NEED] token exists, naming each blocker
- [ ] Approval pins the kit version; kit change flags approved work brand-outdated
- [ ] Contract tests replay CreativePieceMachine scenarios 3 and 4
