# Extension v4 control-flow review

Source reviewed and exercised: `2fea009e0a3015d6aec73eec35bbe45555edbb7c`.
The cancellation proof improvement is test commit
`66b38e6436b671241e021c031e1c33690bb67e35`.

## Scope and limits

This is an independent real-auth, real-PGlite, rootless-runner review of the
extension control flows. It covers the existing browser tests named below and
source review of wiring, uninstall, and reinstall paths. It does not modify
production lifecycle code or CI gates.

This evidence directory contains only this Markdown record. Playwright traces,
blob reports, screenshots, request bodies, and headers remain outside the
worktree because real-auth artifacts can contain session material.

## Behavior matrix

| Required behavior | Evidence | Result |
| --- | --- | --- |
| A fresh built release cannot run before approval | `extension-release-gate.spec.ts` asserts disabled state before the browser human approval, then renders the real tool output only after activation. | Pass |
| Exact approval installs and activates the tested release | `extension-release-gate.spec.ts` checks the review checkbox gate, active release id, and real chat output. `extension-project-authority.spec.ts` checks the separate human project review control. | Pass |
| Adding a release to a conversation permits real use | `extension-control-flow.spec.ts` and `extension-release-gate.spec.ts` call `wireExtensions`, then invoke the isolated tool and assert its returned marker/output. The normal visible add path is also the sent extension mention in `src/runtime/mention-wiring.ts`; its browser proof is owned by the UI review. | API flow passes; UI proof delegated |
| Removing a release from a conversation revokes use | No API, harness client method, query helper, or visible UI removes a `conversation_extensions` row. Existing flows do not prove a post-detach denial. | Product/implementation gap |
| Disable denies new calls | `extension-control-flow.spec.ts` invokes after `disable` and requires rejection. | Pass |
| Uninstall removes live catalog visibility and denies routes | `extension-control-flow.spec.ts` checks the list, name/id routes, and retained lifecycle history after uninstall. | Pass |
| Uninstall then reinstall does not revive former approval authority | Reopening the same v4 installation is deliberately rejected: `ExtensionLifecycle.createWorkspace` throws `uninstalled`; source adoption rejects an uninstalled target. A same-name new installation is possible but has no real-auth retained-data and stale-approval proof. | Unsupported as a same-installation flow; missing new-install proof |
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

## Cancellation drain and fault sensitivity

The cancellation test formerly used a fixed five-second delay. Test commit
`66b38e6436b671241e021c031e1c33690bb67e35` replaces it with an observed
drain boundary on the existing authenticated preview cancel route. The first
acknowledgement proves the invocation had started and entered
`cancel_requested`; repeated caller-owned cancellation requests are idempotent
and return the current request state. The test requires `cancelled` before it
releases the extension's pending work and reads storage.

The exact replay command below exited `0`: **1 passed (50.2s)**.

```sh
cd /home/dev/work/EZCorp/extension-v4-flow-review/web
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4284 \
  CONMON=/tmp/ez-audit-ci-conmon \
  bunx playwright test --config playwright.real.config.ts \
  e2e/real-auth/extension-browser-cancel.spec.ts
```

Fault sensitivity was checked by temporarily changing the terminal expectation
from `cancelled` to `finished`. The same command exited `1`; its direct
assertion was:

```text
The cancelled browser request must drain before later effects are checked.
Expected: "finished"
Received: "cancelled"
Timeout 10000ms exceeded
```

The committed expectation was restored and the final green replay above ran
against the restored source. No test endpoint or production seam was added.

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
was found in this review.

## Remaining product gaps

Conversation extension removal is absent from the API, query layer, harness,
and visible UI, so post-detach denial cannot yet be exercised. Reopening an
uninstalled v4 installation is deliberately unsupported; a same-name new
installation exists, but no real-auth flow proves how retained data and former
approval authority behave for it.
