# Define authentication, authorization, and secrets design

Type: grilling
Status: resolved

## Question

Given the workspace-scoped AI Host connection with in-session project selection (ticket 09), the approval-gated Connected Project contract (ticket 08), and the sole-owner Operator model (ticket 05): how are the AI Host connection, the Operator's dashboard session, and each Connected Project's gateway registration authenticated, how are their permissions scoped, and where do credentials and secrets live so that no secret ever transits an AI Host context window?

## Answer

This settles the policy layer. The deployment specifics (which keychain or KMS, where the gateway runs) belong to the technical-architecture ticket.

### AI Host connections: OAuth per the MCP spec

The gateway implements the MCP authorization spec (OAuth 2.1) so ChatGPT and Claude connect through their native connector flows. Each grant is scoped to the workspace and revocable per host from the dashboard. A manually-issued scoped token exists as a fallback for hosts without OAuth support. Project selection stays in-session (ticket 09); the credential never encodes a project.

### Operator dashboard: passkey, single account

One owner account with passkey (WebAuthn) login plus a stored recovery code. No password table. Digest approvals from ticket 09 inherit this strong authentication, so an approval click always means the authenticated owner. Invited collaborators later get their own passkeys under the existing Operator Assignment model; no redesign needed.

### Connected Project registration: per-project service tokens

Registering a Connected Project mints a dedicated machine-to-machine credential: the gateway holds a scoped, rotatable token per project, and each project domain accepts only its own. A compromised credential exposes exactly one project. Registration and rotation live in the dashboard; the ticket 08 conformance suite runs at registration before the project is marked healthy.

### Secrets: one encrypted store, references everywhere else

A single encrypted secrets store owned by MarketingOS holds project service tokens, host OAuth grants, and the social-account credentials ticket 12 requires to stay behind the boundary. Everything outside the store holds opaque references. Hard invariants:

- No secret ever appears in MCP responses, Method Library text, Work Order instructions, proofs, logs, or any AI Host context.
- Gateway responses (including `register_asset` and `get_resource`) are lint-checked for secret-shaped strings before leaving the process.
- Every grant and token is rotatable and individually revocable from one dashboard page.
- The store backend is picked by the architecture ticket (OS keychain locally, KMS-backed when hosted); the reference contract does not change either way.
