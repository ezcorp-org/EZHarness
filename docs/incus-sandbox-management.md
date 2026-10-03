# Manage Incus sandboxes

The Incus management page is an admin-only control panel at `/extensions/incus-management`. It manages named EZHarness project sandboxes backed by Incus. A new project starts with an empty workspace. The current flow does not copy an existing project, clone a repository, or bootstrap source code.

## Set up and qualify an environment

1. In **Extensions**, review and activate the Incus provider. Open **Set up Incus** and review the server plan and exact digest before applying it. Check the saved setup status after apply.
2. Open **Incus sandboxes**. Select an environment and review its preset resource limits. If a verified setup is available, use **Set sandbox limits** to read host capacity, review the exact plan, and apply it.
3. For an unqualified environment, choose **Prepare qualification**. Review the fixture scope, directory, project and binding IDs, canary paths, profile, generation, and digest before applying the fixture plan.
4. When the host is ready, confirm and start live qualification. It can create temporary test guests and restart EZHarness. The page retains the run identity and checks its saved status after refresh or a lost response. Do not start a second plan while the current fixture workflow needs cleanup.
5. Remove the temporary fixtures after the run completes. A connection check or setup verification does not qualify a sandbox preset.

The current setup also depends on operator-managed SSH access, certificate pins, a reviewed guest image and helper, host capacity, and the qualification supervisor. The browser does not accept SSH paths, endpoints, raw commands, or private keys.

## Create and use a project sandbox

Choose a qualified environment, enter a new project name, and select **Create project sandbox**. EZHarness creates the project, owner membership, quota, and Incus binding together. It does not make a local project directory first.

The page lists each sandbox's desired state, observed state, and last operation. Use **Refresh status** to read saved state. Start a stopped sandbox to resume work. **Open chat** appears only when the sandbox is confirmed running and no lifecycle operation is pending. Stop it to release compute while retaining its workspace.

Chat uses the native EZHarness agent loop. Project file and shell tools use the guest workspace. A stopped, unavailable, or unconfirmed sandbox refuses project work without falling back to AMD execution.

**Dispose** asks for confirmation and removes sandbox workspace data. Save required work first. Retired bindings may require a cleanup retry.

## Recover an unfinished operation

Refresh status before another action. If a result is unknown, the provider may have accepted the operation while its reply was lost. Use **Reconcile pending work** for the saved operation. Keep the same operation identity; do not create a second sandbox to clear an unknown result.

If qualification or fixture apply is uncertain, use its saved-status check. Do not cancel an apply after it was sent. If the browser reports a damaged saved request, stop creating sandboxes until an administrator checks the matching project, binding, or host fixtures.

## Supported behavior and validation

The page supports qualification fixture planning, host-capacity planning, project sandbox creation, status refresh, start, stop, reconciliation, confirmed disposal, and chat entry for a confirmed running sandbox. It does not offer repository bootstrap, preview control, or guest process-log browsing.

Authenticated browser tests use mocked Incus API responses. They prove the UI flow and recovery behavior, not a live Incus lifecycle. The 0.1.2 setup has a recorded verified apply and read-only transport evidence, but the live preset qualification, cross-project denial proof, and full EZHarness-owned create/use/reconnect/destroy sequence remain open. See [the current live gates](../gates/incus-live-pr303.md) for the exact evidence and remaining checks.
