# Native project work on a real Incus sandbox

Status: prepared, not executed. This procedure closes G5 only after the listed observations pass. It does not replace preset qualification or negative isolation checks.

## Preconditions

- The live owner completes the saved STOP reconciliation and destroys the original smoke guest. Do not repeat uncertain operations.
- The exact active release, connection, preset, image, helper, and qualification are verified.
- The owner uses the management page to create a new user project. Record its generated `incus-project-<48 hex characters>` ID, binding, workspace, generation, and Incus instance. The qualification fixture uses a different ID format and cannot substitute for this user flow. Conversation validation must accept the actual generated user-project ID and enforce project membership.
- Read `/api/providers` and `/api/models` with the isolated app's existing human session. Record only model/provider identifiers and credential-presence status. Use an existing configured real model. Do not expose secrets or alter the service environment.
- Record a host canary's content hash and metadata before work. Put the same relative path in the guest with different content. The live owner must prepare this fixture through reviewed guest tools, not by copying AMD source into a guest.

## Product entry and tool proof

Open `/extensions/incus-management`. Confirm the new project is RUNNING with no pending operation. Choose **Open chat**. Confirm the resulting conversation belongs to the new project. Use that conversation for all steps; record each run ID.

Send a bounded prompt through the normal composer or `POST /api/conversations/:id/messages`, using the existing configured provider/model. Request these exact operations in order, and require the agent to stop on any failed tool:

1. `shell`: create `g5-native`; initialize Git inside it with `git init g5-native`; configure repository-local test name and email. Print the guest hostname and working directory. Do not access a network remote.
2. `editFile`: create `g5-native/proof.txt` with a fresh recorded nonce and `stage=before`.
3. `readFile`: read that file and the guest canary. The result must contain the guest canary value, not the host value.
4. `editFile`: replace `stage=before` with `stage=after` using `old_string` and `new_string`.
5. `grep`: search `g5-native` for the nonce and changed stage. `glob` and `listFiles` must also locate `proof.txt`.
6. `shell`: run a deterministic file assertion (`test` against the exact expected content), `git -C g5-native add proof.txt`, and a local commit. Print `git -C g5-native status --porcelain` and `git -C g5-native rev-parse HEAD`.
7. `readFile`: read the committed content again.

Read `GET /api/conversations/:id/messages?withToolCalls=true` after each completed run. Assert the saved tool names, inputs, outputs, success states, run identity, and expected nonce. An assistant's statement alone is not evidence. A successful run can contain failed tools, so check each tool result. Read the same file and Git HEAD through an independent reviewed guest observation. Re-read the host canary and prove its hash and metadata did not change.

## Retention and refusal

Use **Stop** on the same project. Record the admitted operation ID, its terminal status, and observed STOPPED state. Send a normal message requesting file work while stopped. It must refuse project execution before creating a run or touching host files. Record its error and unchanged host canary.

Use **Start** on that project and retain the same workspace ID. Wait for terminal success and observed RUNNING state. Open a new chat from management and request `readFile` plus `shell` Git HEAD. Compare exact content and commit to the earlier observations. Refresh the browser and saved management state. This proves retained work across lifecycle and browser reconnection; an app restart requires a separate reviewed supervisor step.

Use **Dispose** and its existing confirmation. Record the saved operation and terminal result. Prove the matching Incus instance is absent and project inventory contains no test guest. Do not erase retained work before its proof is saved.

## Evidence and limits

Save sanitized request/response records, saved tool rows, guest/host observations, and browser screenshots. Bind all records to the exact release and project/workspace identities. Compose execution already proved on the smoke guest is separate evidence; rerun Compose through this project's `shell` tool if G5 requires the same project workflow. Do not infer automatic repository bootstrap, preview control, or process-log UI: those are not implemented.

The existing deterministic alternative is `HarnessClient.runScripted`: it scripts only the LLM HTTP boundary and executes the native tool loop. It requires the existing fail-closed test surface (`EZCORP_ALLOW_TEST_SURFACE=1`, `PI_E2E_REAL=1`, and nonproduction). Use only a separately reviewed disposable app if this surface is closed. Label that result as deterministic routing evidence, not a real-model run. `/api/tool-invoke` invokes extension tools and cannot substitute for native chat tool execution.
