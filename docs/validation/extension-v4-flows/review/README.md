# Extension v4 control-flow review

Source reviewed and exercised: `2fea009e0a3015d6aec73eec35bbe45555edbb7c`.
The cancellation proof improvement is test commit
`66b38e6436b671241e021c031e1c33690bb67e35`.

## Scope and limits

This is an independent real-auth, real-PGlite, rootless-runner review of the
extension control flows. It covers the existing browser tests named below and
source review of wiring, uninstall, and reinstall paths. It does not modify
production lifecycle code or CI gates.

This evidence directory contains Markdown and a sanitized diagnostic receipt.
Playwright traces, blob reports, screenshots, request bodies, and headers
remain outside the worktree because real-auth artifacts can contain session
material.

## Behavior matrix

| Required behavior | Evidence | Result |
| --- | --- | --- |
| A fresh built release cannot run before approval | `extension-release-gate.spec.ts` asserts disabled state before the browser human approval, then renders the real tool output only after activation. | Pass |
| Exact approval installs and activates the tested release | `extension-release-gate.spec.ts` checks the review checkbox gate, active release id, and real chat output. `extension-project-authority.spec.ts` checks the separate human project review control. | Pass |
| Adding a release to a conversation permits real use | `extension-control-flow.spec.ts` and `extension-release-gate.spec.ts` call `wireExtensions`, then invoke the isolated tool and assert its returned marker/output. The UI lifecycle replay also selects the normal sent extension mention, verifies the persisted conversation wiring, and invokes the real extension output. | Pass |
| Removing a release from a conversation revokes use | No API, harness client method, query helper, or visible UI removes a `conversation_extensions` row. Existing flows do not prove a post-detach denial. | Product/implementation gap |
| Disable denies new calls | `extension-control-flow.spec.ts` invokes after `disable` and requires rejection. | Pass |
| Uninstall removes live catalog visibility and denies routes | `extension-control-flow.spec.ts` checks the list, name/id routes, and retained lifecycle history after uninstall. | Pass |
| Same-name fresh installation after uninstall | Reopening an uninstalled v4 installation is deliberately rejected: `ExtensionLifecycle.createWorkspace` throws `uninstalled`; source adoption rejects an uninstalled target. A real-auth replay reached the fresh, administrator-owned installation's human approval and activation; it returned a failed activation with diagnostic `extension_name_in_use` / `Another installation owns this extension name`. This is the intended name-reservation boundary: source imports require an exact target id and names never auto-match or transfer ownership. | Expected denial observed; same-name fresh reinstall is unsupported |
| Distinct-name fresh installation after uninstall | The source-import replay at `6c7ce08a`, then the parent's full real-auth replay at `64a8f0f3`, approved the exact fresh release, rejected an old approval, and verified empty storage followed by a new write/read. | Pass |
| Failed update retains prior active release | `extension-control-flow.spec.ts` and `extension-release-gate.spec.ts` build invalid source, assert a failed operation, preserve the active release, and invoke the old real output. | Pass |
| Browser cancellation prevents a delayed effect | `extension-browser-cancel.spec.ts` observes the running request, requires the first real cancel acknowledgement to be `cancel_requested`, then repeats that same normal cancel request until the existing idempotent route reports terminal `cancelled`. Only then does it release the blocked extension and prove `late` storage was not written. | Pass |

## Commands and results

Both frozen installs used Bun `1.3.14` from
`/tmp/ez-extension-bun-1.3.14/bun-linux-x64`.

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH bun install --frozen-lockfile

flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH bun install --cwd web --frozen-lockfile
```

Both install commands exited `0`.

The first Playwright attempt exited `1` before starting because its worktree
relative config path incorrectly became `web/web/playwright.real.config.ts`.
The following corrected command is the authoritative test result:

```sh
cd /home/dev/work/EZCorp/extension-v4-flow-review/web
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4284 \
  CONMON=/tmp/ez-audit-ci-conmon \
  bunx playwright test --config playwright.real.config.ts \
  e2e/real-auth/extension-control-flow.spec.ts \
  e2e/real-auth/extension-project-authority.spec.ts \
  e2e/real-auth/extension-release-gate.spec.ts \
  e2e/real-auth/extension-browser-cancel.spec.ts
```

It exited `0`: **4 passed (1.5m)**. The run used a fresh real PGlite database
and the authenticated rootless extension runner. Build output included existing
Svelte accessibility/state warnings and local embedding-model load warnings;
the four tests still passed and no browser/server test error was emitted.

## Full backend and coverage receipts

The earlier full backend wrapper exited `0`: **24,613 pass, 0 fail, 1,564
files**. Its compressed raw receipt is
[`extension-v4-review-backend-final-20260906.log.gz`](raw/extension-v4-review-backend-final-20260906.log.gz)
(SHA-256 `db0244f3f9b6b06bb2a48a80d1ac23770cd6fde5b7e2fed7a210ca3de07ebf14`).

The final locked coverage wrapper ran at
`03733367da65a51d77b80145c5b6fb729e3f4c38` with Bun `1.3.14` and Node
`v22.22.2`. It exited `0`: **25,880 pass, 0 fail, 1,551 shards**; all
**1,246** enforced coverage files met their thresholds. The compressed raw
receipt is
[`extension-v4-review-backend-coverage-20260906.log.gz`](raw/extension-v4-review-backend-coverage-20260906.log.gz)
(SHA-256 `7f248251c8c70323e3647cedcfa8acf1f9c6e571f858fc32b504677d9da6687b`).

Coverage emitted two non-fatal Rolldown parse notices for byte-identical,
generated `web/.svelte-kit/.svelte-check` mirrors of route TypeScript files.
They were excluded during remapping and did not represent unmeasured product
source; no coverage configuration was changed.

After producer registration in `95eb923b`, the five canonical coverage legs were rerun and merged with the preserved full coverage above. The parent independently repeated the canonical merge and gates at `5898793a`: 1,247 file thresholds, 131 new files, and 381 changed files passed against `origin/main`. [Parent receipts and exact input hashes](../parent/combined-checks.json) preserve this final result.

## Cancellation drain verification

The cancellation test formerly used a fixed five-second delay. Test commit
`66b38e6436b671241e021c031e1c33690bb67e35` replaces it with an observed
drain boundary on the existing authenticated preview cancel route. The first
acknowledgement proves the invocation had started and entered
`cancel_requested`; repeated caller-owned cancellation requests are idempotent
and return the current request state. The test requires `cancelled` before it
releases the extension's pending work and reads storage.

An initial replay of this committed test exited `0`: **1 passed (50.2s)**.
After restoration from the controlled production fault, the same test exited
`0`: **1 passed (50.3s)**. Its secret-safe diagnostic receipt, local raw-log
paths, and SHA-256 checksums are in
[`cancellation-restored-green-20260906.txt`](receipts/cancellation-restored-green-20260906.txt).

```sh
cd /home/dev/work/EZCorp/extension-v4-flow-review/web
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4284 \
  CONMON=/tmp/ez-audit-ci-conmon \
  bunx playwright test --config playwright.real.config.ts \
  e2e/real-auth/extension-browser-cancel.spec.ts
```

An assertion sanity check temporarily changed the expected terminal state from
`cancelled` to `finished`; it failed with `Expected: "finished"` and
`Received: "cancelled"`. This verifies that the expectation is active. It is
not a fault-sensitivity result.

The controlled production fault removed the one SQL update that persists the
new cancellation state in `BrowserInvocationStore.cancel()`. With the browser
test unchanged, the same command exited `1` because the normal cancel route
continued to return `cancel_requested` and the test could not observe terminal
`cancelled`. The source was restored before the final green replay. The
secret-safe diagnostic receipt, raw-local paths, SHA-256 checksums, exact
mutation, command, and result are in
[`cancellation-production-fault-20260906.txt`](receipts/cancellation-production-fault-20260906.txt).

The fault run reported:

```text
The cancelled browser request must drain before later effects are checked.
Expected: "cancelled"
Received: "cancel_requested"
Timeout 10000ms exceeded
```

No test endpoint or production seam was added.

## Visual inspection

An evidence replay of the project authority and release gate tests exited `0`:

```sh
cd /home/dev/work/EZCorp/extension-v4-flow-review/web
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4284 \
  CONMON=/tmp/ez-audit-ci-conmon EZCORP_E2E_EVIDENCE=1 \
  bunx playwright test --config playwright.real.config.ts \
  e2e/real-auth/extension-project-authority.spec.ts \
  e2e/real-auth/extension-release-gate.spec.ts
```

It reported **2 passed (1.1m)** and created `web/blob-report/report-51fcfb6.zip`.
The HTML report was rendered outside the worktree and all four attached PNGs
were inspected. The desktop project-review page presents the exact commit,
file list, checkbox, and disabled decision buttons clearly. The 390px mobile
view has no horizontal overflow and keeps the review checkbox and decisions
readable. The chat screenshots show two independent real release outputs, then
the new release output after activation. No visible clipping or layout defect
was found in this review. The current local report paths are
`/tmp/ez-terra-visual-report-20260906/index.html` and its four PNGs under
`/tmp/ez-terra-visual-report-20260906/data/`; those files, the blob ZIP, and
the original authenticated runner output are not committed.

## Related import replay

The proposed same-name reinstall scenario at source
`9e4a3dbd09da8470d9713e4ba394858652d3c13e` was started with the command below.
It reached the test but was still on the permission review around 389 seconds,
after its 360-second test budget. It was terminated at about 6:25 process time
to release the shared validation lock. Its shell exit was `1`, so this is an
incomplete run, not a pass or a behavioral result.

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  zsh -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; \
  export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4283 \
  EZCORP_E2E_EVIDENCE=1; cd web && bunx playwright test \
  --config playwright.real.config.ts \
  e2e/real-auth/extension-source-import.spec.ts'
```

The incomplete runner log is at
`/home/dev/work/EZCorp/extension-v4-flow-import/docs/validation/extension-v4-flows/import/raw/marketplace-lifecycle-9e4a3dbd.log`.
Its trace is transient and was not copied because it used real authentication.

## Remaining product gaps

Conversation extension removal is absent from the API, query layer, harness,
and visible UI, so post-detach denial cannot yet be exercised. Reopening an
uninstalled v4 installation is deliberately unsupported, as is a same-name
fresh installation: names reserve their original installation and cannot become
an ownership-transfer mechanism. The completed source-import replay and the
parent's full real-auth replay verify distinct-name activation, stale-approval
denial, and fresh storage isolation.
