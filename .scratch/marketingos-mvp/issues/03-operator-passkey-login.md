# 03: Operator passkey login

**What to build:** The single-account owner login. Passkey (WebAuthn) registration and sign-in, a stored recovery code, session management, sign-out. No password path.

**Blocked by:** 01 Walking skeleton.

**Status:** done

- [x] First-run creates the sole Operator account with a passkey and shows a recovery code once
- [x] Sign-in with the passkey and recovery-code fallback both work
- [x] All dashboard routes require an authenticated session

## Comments

- Implemented WebAuthn passkey registration (first-run, sole Operator) with a one-time recovery code, passkey sign-in plus recovery-code fallback, cookie sessions with sign-out, and an authenticated-session guard on all dashboard routes. PR: https://github.com/BautistaPessagno/Distribution/pull/3
