# Review: personal GitHub connections

Reviewed 2026-09-22 against [the connection plan](2026-09-22-user-github-connections-for-prs.md), the [in-app PR draft](2026-09-20-simple-in-app-prs.md), checkout `197fb6c94`, and Factory branch `feat/composable-factory-platform` at `94fb95b6a`.

**Recommendation: keep the GitHub App user-token design, but revise the plan before implementation.** It is a good fit for connecting once and publishing as the user. The plan does not yet fully specify how use is limited to that user's sandbox and runs.

Keep the account connection separate from project settings. Keep tokens on the trusted host. Let a user's run request a specific operation through the host; do not give the sandbox a GitHub token. GitHub recommends user access tokens for actions taken on a user's behalf because access is limited by both the user and the App. [GitHub token guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#use-the-appropriate-token-type).

1. **High — Make sandbox and run ownership an explicit authorization rule.**

   Plan lines 25 and 53 bind a proposal to a user and run, but the listed checks do not explicitly require a matching sandbox owner and workspace identity. Line 55 binds Factory operations to the person who consents; consent alone must not turn someone else's run into that person's run.

   The current controller stores `sandbox_provider_bindings.owner_id` when creating a sandbox, but its status gate checks project membership. Method admission checks conversation ownership when a conversation is supplied. Native workspace execution checks conversation ownership and binding revision. These checks do not establish an exclusive user sandbox: another project member can have their own conversation against the same project workspace. See [creation and admission](../../src/runtime/sandbox/controller/controller.ts#L357), [membership gate](../../src/runtime/sandbox/controller/controller.ts#L132), and [workspace execution](../../src/runtime/sandbox/controller/controller.ts#L443).

   Require the same user for the connection, initiating run, conversation, sandbox owner, proposal, and confirming session. Derive these values from stored records. Bind the proposal to the sandbox binding, resource incarnation, workspace revision, repository, and immutable change set. For the requested personal path, reject a shared workspace or provide a separate private workspace for the user's run. Enforce this boundary on workspace access as well as publication; checking the publisher cannot prevent another member from changing a shared working tree. A local host workspace must not silently qualify as the user's sandbox.

   Add a same-project A/B test: B has project membership but cannot use A's connection, submit A's run, read or modify A's private workspace, or approve A's proposal. Include an application admin, a service principal, missing ownership, and a replaced sandbox binding. Application admin status must not bypass personal connection ownership. The host operator remains inside the trust boundary, as the plan already states.

2. **High — Complete the Connect flow with repository installation and recovery.**

   Plan lines 22–24 and 46–48 cover user authorization and access checks. They do not describe how a user grants the App access to a missing repository, requests organization approval, or returns from that process. A user can complete authorization and still be unable to publish. GitHub treats installation and user authorization as separate grants; organization policy can require an owner to approve installation. [GitHub installation requirements](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).

   Define one guided flow: **Connect GitHub → authorize account → grant access to selected repositories when needed → return to the original PR review**. Show separate states for account connected, repository not enabled, organization approval pending, and insufficient user permission. Offer the appropriate GitHub installation or access-management link. Validate installation results through GitHub; a callback installation ID is not proof of authority. Explain that each project also needs GitHub repository access, even though the account is connected once.

   Add the operator setup contract: who registers the App, how callbacks work for a self-hosted instance, which accounts can install it, and which permissions are required. Start with Metadata read, Contents write, and Pull requests write, verified against the actual publisher endpoints. Decide explicitly how workflow-file changes are handled. A private App cannot support installation on arbitrary users' accounts. [App installation visibility](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

3. **High — Fence the full connection lifecycle, including pending authorizations.**

   Plan lines 39–41 mention versioning and refresh serialization; lines 27 and 47 require immediate local disconnect and atomic reconnect. They do not specify how these operations interact. A callback started before Disconnect could otherwise restore access afterward. A late refresh could overwrite a replacement connection. An old proposal could become usable again after disconnect and reconnect to the same GitHub account.

   Define an authorization generation that changes on disconnect, account replacement, and reconnect. Bind OAuth attempts and proposals to it. Consume callbacks and save refresh results only if the expected generation and current connection still match. Keep ordinary token rotation separate from the authorization generation so refresh does not invalidate a valid approval. A new connection must not revive old proposals; require new approval. GitHub refresh invalidates both the previous refresh token and access token, so replacement must be atomic. [GitHub refresh rules](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

   Use the same durable coordination for dispatch and disconnect. Define the boundary precisely: disconnect blocks writes not yet dispatched, but cannot recall a request GitHub already received. Such requests retain uncertain-outcome recovery. Test delayed callback after disconnect, refresh versus reconnect, refresh versus disconnect, same-account reconnect with an old proposal, and disconnect after dispatch. Control the interleaving in tests; do not depend on wall-clock timing.

4. **High — Specify how the user's sandbox produces the publishable snapshot.**

   Plan lines 35 and 53–55 assume a shared publisher can consume the run's changes. The in-app PR draft calls for an isolated worktree, but this is still planned work. The current sandbox creator accepts only an empty workspace and rejects `sourceProjectId`. Sandbox targets deliberately contain no host filesystem root. The existing publisher expects a local `projectRoot`. See [sandbox creation](../../src/runtime/sandbox/controller/controller.ts#L357), [workspace target](../../src/runtime/workspace/target.ts#L34), and [publisher input](../../src/extensions/project-open-pr.ts#L82).

   Add a concrete prerequisite: import or select the approved repository/base, then export a bounded immutable snapshot from the owner's sandbox through the provider boundary. Validate the export on the host and publish from a private staging workspace or a validated artifact adapter. Do not infer a host directory from a container path or expose a host Git credential to guest Git commands. Freeze the reviewed snapshot so later sandbox edits cannot change what is published.

   Make the v1 capability explicit: **PR publication from the user's own sandbox run**. If private clone/fetch is also needed to start that run, give it an explicit host-brokered operation and authorization checks. Connecting an account must not imply that arbitrary `gh`, Git, or HTTP commands inside the sandbox now have account access. Test the complete repository-to-sandbox-to-PR path and a second run trying to substitute the exported artifact.

5. **Medium — Resolve the Factory policy question before building the dependent path.**

   Plan lines 55 and 62 correctly require live proof that user-token publication works with the selected ruleset. However, that proof comes late, and line 64 makes publication readiness depend on it. The Factory contract requires a release branch namespace writable only by the release broker. A normal user PR and that release contract may need different policies.

   Move a small real GitHub proof to the start: prove selected-repository installation, user-token branch creation, draft PR creation, and the intended branch protections. GitHub rulesets grant bypass to classes of actors such as roles, teams, and Apps; do not assume they establish a per-operation restriction on a user token. The host must enforce the exact operation. [GitHub ruleset actors](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset).

   Keep one publisher and explicit authorization adapters. Ship personal Settings and the personal sandbox PR path against their own stated guarantees. Add the Factory adapter when its identity and immutable-branch contract are proven. Do not weaken Factory guarantees or silently substitute an installation token if that proof fails.

Recommended implementation order:

1. Amend both plans with the ownership rule, v1 operations, installation flow, and lifecycle generation.
2. Prove GitHub user-token behavior and select the App setup and branch policy.
3. Add encrypted personal connections and the guided Settings flow.
4. Complete private sandbox/run snapshot handling and the host publication adapter.
5. Run the same-project cross-user tests, lifecycle race tests, and real repository journey; then add Factory integration under its separate contract.

The resulting boundary should be simple: the browser manages its own connection; the authenticated run can propose an operation for its own sandbox; the same human approves the exact snapshot; the host validates ownership and performs the GitHub call. Neither the model nor the sandbox receives reusable GitHub credentials.

Validation: reviewed the cited source paths and current official GitHub documentation. These are plan findings, not reproduced product defects. No product code changed, no credentials were created, and no browser or live GitHub publication test was run. The real provider proof remains an implementation prerequisite.
