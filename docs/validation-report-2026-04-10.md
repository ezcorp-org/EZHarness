# ez-corp-ai Validation Report

**Date:** 2026-04-10
**Auditor:** `ezcorp-validation` team (9 agents, parallel sweep)
**Scope:** Feature correctness, test coverage (unit/integration/e2e), security
**Mode:** Report-only — no code changes were made.

---

## Executive Summary

**Overall verdict:** :red_circle: **DO NOT DEPLOY** until the Critical security findings are fixed.

The project has strong feature coverage and solid sandbox engineering, but the auth/authz layer contains **five single-request paths to full admin compromise** by any logged-in user. The test suites also have failing assertions that must be triaged before the next release.

| Dimension | Result | Severity |
|---|---|---|
| Unit / integration tests | 4488 pass / **7 fail** / 257 files | High (regression cluster in executor wiring) |
| Web unit tests | 2230 pass / **2 fail** / 102 files | Medium |
| Playwright e2e browser tests | **NOT RUN by `scripts/test-web.sh`** | High (coverage gap) |
| Feature inventory coverage | 193 / 200+ features (~96%) | Low (7 minor orphans) |
| Unit-module coverage | 95 / 128 source files (74.2%) | Medium (runtime/tools at 40%) |
| E2E route coverage | 25 / 29 routes (86%) | Low (4 gaps, incl. `/auth/callback`) |
| Cross-module integration | 5 covered / 2 partial / 8 broken seams | Medium |
| **OWASP security review** | **5 Critical / 4 High / 4 Medium / 5 Low** | **Critical** |
| Dependency CVEs | **4 advisories across 2 pkgs** (drizzle-orm, vite) | High |
| Secret leaks | 0 true positives | None |
| Extension sandbox | 13 bypass classes covered / 6 gaps | Medium |

---

## :warning: Immediate actions (block release)

### Critical security — fix before next deploy

1. **C1 — Non-admin users can read the JWT secret and forge admin tokens.**
   `web/src/routes/api/settings/[key]/+server.ts:7-35`. `requireScope("admin")` returns `null` for cookie auth (`web/src/lib/server/security/api-keys.ts:44`), so any logged-in user can `GET /api/settings/instance:jwtSecret` and then mint a `role:"admin"` JWT with the HS256 secret (stored plaintext, `src/auth/jwt.ts:83-106`). **Full system takeover in two HTTP calls.**

2. **C2 — Logout and admin session revocation do not actually work.**
   `web/src/hooks.server.ts:267-283` contains a "migration bridge" that silently re-creates a deleted session row for any still-valid JWT. `POST /api/auth/logout` and `DELETE /api/admin/sessions` are defeated until the JWT naturally expires in 30 days.

3. **C3 — Any authenticated user can install an extension with attacker-chosen permissions → RCE.**
   `web/src/routes/api/extensions/+server.ts:20-44` + `src/extensions/installer.ts:25-58`. Route is gated only by `requireScope("extensions")` (no-op for cookie auth). A normal user can `installFromLocal` or `installFromGitHub` with `{shell:true, filesystem:["/"]}`, then `POST /api/tool-invoke` → arbitrary code execution as the server-process user.

4. **C4 — Any authenticated user can grant arbitrary permissions to any installed extension → RCE.**
   `web/src/routes/api/extensions/[id]/permissions/+server.ts:17-30`. PUT writes `grantedPermissions` verbatim with no role check and no clamp to what the manifest requested. Combined with C3 it's also independently exploitable against pre-installed extensions.

5. **C5 — Any authenticated user can overwrite or delete LLM provider API keys.**
   `web/src/routes/api/providers/+server.ts:76-109`. Billing-redirection / DoS for every user on the instance.

**Two structural fixes close most of the Critical + High bucket:**
- Replace every `requireScope(locals, "admin")` site with a real role gate (`requireRole(locals, "admin")`), or add a `requireAdminOrAdminScope` helper. This kills C1, C3, C4, C5, H1 at once.
- Delete the session auto-recreate branch in `hooks.server.ts:267-283`. This kills C2.

### Critical dependencies — patch bumps only

6. **`drizzle-orm` 0.45.1 → 0.45.2** — HIGH SQL-injection via `sql.identifier()` / `.as()` escape bypass ([GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9), CVE-2026-39356). Also audit call sites that pass user input into dynamic identifiers or sort columns as defense-in-depth.

7. **`vite` 7.3.1 → 7.3.2** — three advisories:
   - CVE-2026-39363 (HIGH) — arbitrary file read via dev-server WebSocket
   - CVE-2026-39364 (HIGH) — `server.fs.deny` bypass via query strings
   - CVE-2026-39365 (MODERATE) — path traversal in optimized-deps `.map` handling
   Dev-only impact, but any LAN-exposed dev server is a direct compromise vector.

### Test runner gap — wire Playwright into CI

8. **`scripts/test-web.sh` does NOT run Playwright browser tests.** It only runs `bun test` against `web/src/__tests__/*`. The ~90 specs in `web/e2e/*.spec.ts` were **not executed in this validation run**. Either rename / fix the script or add a separate `scripts/test-e2e.sh` that runs `bunx playwright test`. Until this is done, the 86% e2e route-coverage number is notional — we know the specs exist, not that they pass.

---

## Section 1 — Test results

### 1.1 Unit / integration (`scripts/test.sh`)

- Totals: **4488 pass / 7 fail / 257 files**, exit code 1
- Full log: `/tmp/ezcorp-test-unit.log`

| File | Failing assertions |
|---|---|
| `src/__tests__/executor-agent-wiring.test.ts` | 3 — tool-restriction filters + member overrides |
| `src/__tests__/executor-task-wiring.test.ts` | 1 — `task_plan on conv A does not affect conv B's store` |
| `src/__tests__/invoke-agent-tool.test.ts` | 1 — `no overrides applied when agentConfigId not in memberOverrides map` |
| `src/__tests__/orchestrator-prompt-task.test.ts` | 1 — `mentions agent attribution in the task panel` |
| `src/__tests__/ext-dev.test.ts` | 1 — `cleans up stale dev: entries on startup` (5001 ms → timeout) |

Five of the six failures cluster around executor tool-restriction, member overrides, and agent attribution — likely **one underlying regression** in the orchestration wiring, not five independent bugs. The `ext-dev` failure is a classic 5 s timeout and worth re-running with a longer budget to confirm it's not a flaky cleanup.

### 1.2 Web (`scripts/test-web.sh`)

- Totals: **2230 pass / 2 fail / 102 files**, exit code 1
- Full log: `/tmp/ezcorp-test-web.log`

| File | Issue |
|---|---|
| `web/src/__tests__/memories-api-post.test.ts` | `fail` count > 0 but no `(fail)` assertion line — suspected top-level load/setup error. Re-run directly to get the real error. |
| `web/src/__tests__/tasks-assignment-api.test.ts` | `GET /api/conversations/[id]/team/[agentConfigId]/messages > returns team info and member streams` |

### 1.3 Playwright e2e

**Not run.** See action #8 above.

---

## Section 2 — Test coverage gaps

### 2.1 Feature inventory — 96% covered (strong)

200+ features identified across backend routes, agents, extensions, memory, and frontend pages. **All critical happy-path features have tests.** Seven minor orphans identified — all implicitly or adjacently covered, none high-risk. Details: `feature-auditor.md`.

### 2.2 Unit-module coverage — 74.2% (medium; one critical gap)

95 / 128 source modules have tests that import them. **Worst subsystems:**

| Subsystem | Coverage |
|---|---|
| `src/runtime/tools/` | **6 / 15 (40%)** — uncovered: `edit-file.ts`, `glob.ts`, `grep.ts`, `read-file.ts`, `shell.ts`, `list-files.ts`, `read-directory.ts`, `validate.ts`, `types.ts` |
| `src/extensions/sdk/templates/` | **0 / 4 (0%)** — all four template generators untested |
| `src/db/migrations/` | **0 / 1 (0%)** — `add-sub-convo-and-references.ts` |
| `src/db/` | 3 / 5 (60%) — `backup.ts`, `seed-marketplace.ts` |
| `src/memory/` | 7 / 9 (78%) — `compaction.ts`, `injection.ts` |

**Priority 1:** `src/runtime/tools/{edit-file,glob,grep,read-file,shell}.ts` are core user-facing tools and are completely untested — add direct unit tests, don't rely on integration coverage.

### 2.3 E2E route coverage — 86% (low risk)

25 / 29 SvelteKit routes have spec coverage. **Uncovered:**

1. `/signup/[token]` — auth signup flow with token validation
2. `/auth/callback` — OAuth/OIDC callback handler
3. `/pipelines/new` — pipeline creation form
4. `/admin/moderation` — admin moderation dashboard

`/auth/callback` and `/signup/[token]` are critical-path auth flows and should be filled first. No stale specs detected.

### 2.4 Cross-module integration — 5 covered / 2 partial / 8 broken seams

**Fully covered:** chat→memory, chat→tools→extensions, extensions→fs mediation, observability, WebSocket reconnect, memory injection pipeline, multi-project memory isolation.

**Partially covered:**
- **Auth → chat** — auth flow itself is tested, but no integration test covers `login → session cookie → POST /api/conversations → stream`.
- **Agents / teams** — composition constraints are tested, but there is no end-to-end test of orchestrator → spawn subagent → assign task → collect result.

**Top broken seams** (full list in `integration-auditor.md`):
1. Auth session → chat API (cookie propagation never tested end-to-end)
2. Team orchestration full cycle
3. Permission-denied → `denyAndDisable()` → subsequent calls rejected
4. Observability DB failure → chat should still complete (graceful degradation)
5. WebSocket reconnect → message queue replay
6. Memory injection tokens → cost tracking
7. Tool-level observability events (`tool:start`/`tool:end`) persisted
8. Concurrent memory extraction deduplication

---

## Section 3 — Security findings

### 3.1 OWASP code review

**Summary:** 5 Critical / 4 High / 4 Medium / 5 Low. The pervasive root cause is `requireScope(locals, "admin")` being a no-op for cookie-authenticated users — see `web/src/lib/server/security/api-keys.ts:44`.

#### Critical (5)
| ID | Finding | Location | OWASP |
|---|---|---|---|
| C1 | JWT secret readable via settings API → admin forgery | `web/src/routes/api/settings/[key]/+server.ts:7-35` | A01 / A02 |
| C2 | Session auto-recreate nullifies logout/revocation | `web/src/hooks.server.ts:267-283` | A07 |
| C3 | Non-admin can install extension with shell:true → RCE | `web/src/routes/api/extensions/+server.ts:20-44` | A01 / A08 |
| C4 | Non-admin can grant arbitrary permissions to extensions → RCE | `web/src/routes/api/extensions/[id]/permissions/+server.ts:17-30` | A01 |
| C5 | Non-admin can overwrite/delete provider API keys | `web/src/routes/api/providers/+server.ts:76-109` | A01 |

#### High (4)
| ID | Finding | Location | OWASP |
|---|---|---|---|
| H1 | SSRF via `baseUrl` in provider local-test and local-models | `web/src/routes/api/providers/local/{test,models}/+server.ts` | A10 |
| H2 | Tool-call permission approval has no ownership check → low-priv user approves admin's pending `shell` call | `web/src/routes/api/tool-calls/[id]/permission/+server.ts:4-9` | A01 |
| H3 | IDOR in conversations/memories — null `userId` short-circuits the owner check | `web/src/routes/api/{conversations,memories}/[id]/+server.ts` | A01 |
| H4 | Password reset tokens returned in HTTP response body, no out-of-band delivery | `web/src/routes/api/auth/reset-password/+server.ts:35` | A07 |

#### Medium (4)
| ID | Finding | Location |
|---|---|---|
| M1 | OAuth `app_origin` not validated → open-redirect to attacker domain | `web/src/routes/api/auth/oauth/+server.ts:79-84` |
| M2 | OAuth callback does not validate `state` server-side (relies on PKCE only; `codeVerifier` is in JSON response body) | `web/src/routes/api/auth/oauth/callback/+server.ts:61-94` |
| M3 | `/api/fs/list` sandbox is `$HOME` — exposes `.ssh/`, `.aws/`, IDE configs by name | `web/src/routes/api/fs/list/+server.ts:10-41` |
| M4 | `CORS_ALLOWED_ORIGINS="*"` reflects any origin; legacy `pi_session` cookie auto-promoted without validation | `web/src/hooks.server.ts:132-148, 193-202` |

#### Low / Informational (5)
- **L1** Login timing side-channel enables user enumeration (rate-limited, low impact).
- **L2** `touchSession` uses `sql.raw(String(throttleMs))` — not exploitable today, but a fragile pattern.
- **L3** Dev WebSocket on port 3002 has no auth — multi-tenant dev host risk.
- **L4** AES-GCM IV is 16 bytes instead of NIST-recommended 12.
- **L5** `oauth-callback-server.ts` spawns `bun -e <script>` with concatenated literals — currently safe due to `JSON.stringify`, but fragile.

Items explicitly NOT flagged (already defended and tested): JWT HS256 alg confusion, Argon2id password hashing, SvelteKit CSRF default, shell blocklist (intentional capability), extension fs-mediation `realpath` check.

### 3.2 Dependency vulnerabilities

**Confirmed advisories at installed versions:**

| Pkg | Installed | Advisory | Severity | Fixed in |
|---|---|---|---|---|
| `drizzle-orm` | 0.45.1 | GHSA-gpj5-g38j-94v9 / CVE-2026-39356 (SQLi) | **HIGH** | 0.45.2 |
| `vite` | 7.3.1 | GHSA-p9ff-h696-f583 / CVE-2026-39363 (arbitrary file read) | **HIGH** | 7.3.2 |
| `vite` | 7.3.1 | GHSA-v2wj-q39q-566r / CVE-2026-39364 (`fs.deny` bypass) | **HIGH** | 7.3.2 |
| `vite` | 7.3.1 | GHSA-4w7w-66w2-5vf9 / CVE-2026-39365 (path traversal) | MODERATE | 7.3.2 |

Both fixes are **patch-level bumps** on the already-tracked major line — low-risk drop-ins.

**Unable to verify (manual review recommended):**
- `isomorphic-dompurify` 3.7.1 — on the XSS defense path, wraps DOMPurify internally, bundled version not visible. 3.8.0 is available; recommend bumping.
- `@huggingface/transformers` 3.8.1, `@mariozechner/pi-agent-core` 0.57.1, `@mariozechner/pi-ai` 0.57.1 — not well indexed in public advisory feeds.

**Checked and clean at installed version:** `@sveltejs/kit` 2.53.4, `marked` 17.0.4, `highlight.js` 11.11.1, `zod` 4.3.6.

Non-security updates (informational) and the full inventory are in `dep-scanner.md`.

### 3.3 Secret and credential leak scan

:white_check_mark: **Zero true positives.** No committed `.env` files other than `.env.example` (blank placeholders). All pattern hits were test fixtures with obvious placeholder values (`FAKE_*`, `sk-env-key`, `Password123`, `test-secret`). Repo follows good hygiene — no action required.

### 3.4 Extension sandbox & permissions

**Risk: MEDIUM.** Core sandbox is well-designed and well-tested. 13 bypass classes have dedicated tests (path traversal, symlink escape, env isolation, permission enforcement, cross-extension depth limit, manifest checksum, lifecycle-hook allowlist, state-mediator method injection, identity spoofing, HTML stripping, crash auto-disable, etc.).

**Gaps (no dedicated tests):**

1. **Storage RPC security** — no tests for cross-extension isolation, quota enforcement, rate limiting (50 ops/s), key validation, or batch-limit (100 ops). Logic is present at `src/extensions/storage-handler.ts:107-296` but completely untested.
2. **Network egress control** — unclear whether extension subprocesses can `require('http')`/`fetch` and make arbitrary network calls without the `network` permission. No test demonstrates blocking.
3. **`child_process` escape** — subprocess env is explicitly allowlisted, but Node module imports are NOT restricted. An extension that `require('child_process').spawn()` could spawn shells without going through `ezcorp/shell` RPC. **Medium-high risk.**
4. **JSON-RPC injection** — `processBuffer()` (`src/extensions/json-rpc.ts:57-83`) silently skips malformed lines. No tests for conflicting id/method fields, very large payloads, or deeply nested objects.
5. **State-mediator rate-limit concurrency** — token bucket not tested under burst load.
6. **Lifecycle hook handler re-wiring** after process restart — handlers wired once at `tool-executor.ts:137`, no re-wiring tests.

**Action:** Verify whether the subprocess launcher restricts Node module imports; if not, add an `--experimental-permission`-style module blocklist or switch extensions to a Bun Worker-style sandbox that cannot `require('child_process')` or `require('net')` without mediation.

---

## Section 4 — Prioritized next actions

### :red_circle: Block release
1. Fix C1–C5 (auth/authz pattern — one structural change covers most).
2. Remove the session auto-recreate bridge in `hooks.server.ts`.
3. Bump `drizzle-orm` → 0.45.2 and `vite` → 7.3.2.
4. Triage the 7 failing unit tests (likely one executor-wiring regression + one flaky ext-dev cleanup).

### :large_orange_diamond: This week
5. Fix H1–H4 (SSRF, tool-call ownership, IDOR null-check, password reset token delivery).
6. Wire Playwright into CI — add `scripts/test-e2e.sh` or fix `test-web.sh` so browser tests actually run.
7. Investigate extension subprocess module restriction — close the `child_process` / `network` egress gap (extension security finding #2, #3).
8. Add dedicated storage-RPC security tests.

### :large_blue_diamond: Next sprint
9. Fix M1–M4 and L1–L5.
10. Add unit tests for `src/runtime/tools/{edit-file,glob,grep,read-file,shell}.ts` — core tools at 40% coverage.
11. Add the missing integration tests:
    - Auth-session → chat API end-to-end
    - Team orchestration full cycle
    - Tool-level observability events
    - Permission-denied → `denyAndDisable` → subsequent calls rejected
12. Add e2e tests for `/signup/[token]`, `/auth/callback`, `/pipelines/new`, `/admin/moderation`.
13. Verify `isomorphic-dompurify` bundled DOMPurify version; bump to 3.8.0 if it ships a newer DOMPurify.

### :white_circle: Opportunistic
14. Non-security dep bumps (batch them).
15. Major-version bumps scheduled independently: `@electric-sql/pglite` → 0.4, `@huggingface/transformers` → 4, `vite` → 8, `@sveltejs/vite-plugin-svelte` → 7, `marked` → 18, `typescript` → 6, `lucide-svelte` → 1.

---

## Appendix — Source findings files

Full per-auditor reports:

- `~/.claude/tasks/ezcorp-validation/findings/test-runner.md`
- `~/.claude/tasks/ezcorp-validation/findings/feature-auditor.md`
- `~/.claude/tasks/ezcorp-validation/findings/unit-coverage-auditor.md`
- `~/.claude/tasks/ezcorp-validation/findings/integration-auditor.md`
- `~/.claude/tasks/ezcorp-validation/findings/e2e-auditor.md`
- `~/.claude/tasks/ezcorp-validation/findings/security-reviewer.md`
- `~/.claude/tasks/ezcorp-validation/findings/dep-scanner.md`
- `~/.claude/tasks/ezcorp-validation/findings/secret-scanner.md`
- `~/.claude/tasks/ezcorp-validation/findings/extension-security-auditor.md`
