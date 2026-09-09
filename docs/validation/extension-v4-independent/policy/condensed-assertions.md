# Condensed assertion inventory

The original and candidate path is the `Current test` path. Test names were compared between base `537f074e` and candidate `3093a3a5`. Replacement files below were inspected for positive and denied paths. A retired-route refusal is never treated as its own positive replacement.

| Ledger | Current test | Candidate coverage inspected | Result or remaining behavior |
| ---: | --- | --- | --- |
| 54 | `docs/extensions/examples/code-quality/index.test.ts` | Real `analyze-file` and `scan-directory` handlers; delegated-error/no-retry table; `packages/@ezcorp/sdk/src/v4/serve.test.ts` | Positive handlers and exact errors remain. `preuninstall` is C6. |
| 55 | `docs/extensions/examples/code-review-delegator/index.test.ts` | Chained results, recommendations, optional quality failure, denied-read/no-second-call; SDK serve framing | Positive and denied paths remain. |
| 56 | `docs/extensions/examples/extension-author/index.test.ts` | `src/extensions/__tests__/extension-control.test.ts`; `src/__tests__/reopen-extension.test.ts`; author component tests | Positive workspace/build/review path remains. Destructive discard is C4. |
| 57 | `docs/extensions/examples/github-stats/index.test.ts` | Three response mappings; 404/403/500 table; `src/__tests__/github-stats-sdk-integration.test.ts` | Positive mapping plus denial, recovery, and concurrency remain. |
| 58 | `docs/extensions/examples/multi-agent-orchestrator/index.test.ts` | Manifest prompt/tool assertions | Supported prompt guidance remains. Legacy `subAgents` is C6. |
| 59 | `extensions/memory-extractor/manifest-load.test.ts` | Snake-case and negative camelCase manifest checks; lessons-distiller sealed definition | Supported manifest names remain. |
| 60 | `src/__tests__/ai-kit-bundled-install.test.ts` | Opt-out tests; `src/__tests__/bundled-source-registration.test.ts`; sealed definition tests | Positive catalog and opt-out remain through scoped host API authority. |
| 61 | `src/__tests__/authored-install-auto-modifiable.test.ts` | Seven refusal/state tests; `src/__tests__/reopen-extension.test.ts` SQL owner/foreign cases | Positive owner fork and denied foreign path retain active release and grants. |
| 62 | `src/__tests__/bundled-suggest-examples-phantom-drift.test.ts` | Presentation exclusion, source tamper, and tool add/remove hashes; bundled bootstrap | Hash sensitivity remains. |
| 63 | `src/__tests__/define-extension-unit.test.ts` | Identity/helpers and host non-execution; `src/__tests__/ts-manifest-{e2e,integration}.test.ts` | Positive isolated definition and negative executable-metadata paths remain. |
| 64 | `src/__tests__/ext-dev.test.ts` | No-host-import/DB-write/reload canary; `src/extensions/__tests__/cli-control.test.ts` | Safe CLI path remains. Watcher/debounce/session shutdown is C1. |
| 65 | `src/__tests__/extensions-patch-route.test.ts` | Disable/uninstall positives; malformed/conflict/missing/legacy/redaction negatives; lifecycle publication | Positive and denied lifecycle paths remain. |
| 66 | `src/__tests__/mcp-api-routes.test.ts` | Guarded target/probe positives and denials; `web/src/__tests__/helpers/mcp-stage-route-tests.ts`; MCP control/credential tests | Candidate staging and scoped credential paths remain; active catalog stays unchanged. |
| 67 | `src/__tests__/scratchpad-bundled-install.test.ts` | Registration/declaration tests; bundled bootstrap; `src/__tests__/scratchpad-e2e.test.ts` | Positive SQL build/approve/invoke path and disabled staging remain. |
| 68 | `src/__tests__/security/c3-confirm-endpoint.test.ts` | Retired endpoint refusal; `src/extensions/v4/lifecycle.test.ts` builder denial; lifecycle service human-admin positive; `web/src/__tests__/extension-control-routes.server.test.ts` exact approval | Positive human path is separate from agent/API-key denial. |
| 69 | `src/__tests__/security/c3-extension-install.test.ts` | Retired endpoint refusal; `src/extensions/__tests__/source-import-staging.test.ts` local/GitHub positive and owner/admin denials | Positive supported import is separate from retired-route denial. |
| 70 | `src/__tests__/security/c4-extension-permissions-grant.test.ts` | Retired mutation refusal; lifecycle exact-grant positive and mismatch denial | Mutable clamp/toggle path is C2/C3. |
| 71 | `src/__tests__/ts-manifest-sdk-gaps.test.ts` | Config/JSON host-evaluation canaries; isolated manifest, handler, and CLI validation | Positive isolated path and negative host-execution path remain. |
| 72 | `src/__tests__/verify-extension.test.ts` | Legacy refusal; `src/extensions/candidate-verification-broker.test.ts`; lifecycle service smoke tests | Smoke success/error/text mismatch/catalog/schema/no-smoke/cleanup cases remain. |
| 73 | `src/__tests__/web-search-bundled-install.test.ts` | Sealed tool names and search-only declaration; bundled bootstrap | Positive discovery and no-backfill staging remain. |
| 74 | `src/__tests__/web-search-search-grant-reconcile.test.ts` | Real search handler absent-grant denial and explicit-grant success; bundled bootstrap | Both allowed and denied handler paths remain; startup cannot restore grants. |
| 75 | `web/src/__tests__/api-extensions-id-permissions.server.test.ts` | Auth/read positive and mutation refusal; lifecycle/authoring exact consent | Mutable controls and TTL UI are C2/C3. |
| 76 | `web/src/__tests__/api-extensions-id-reapprove-drift.server.test.ts` | GET/POST auth/refusal; bundled source identity and lifecycle exact approval | Positive approval is separate; live disk healing stays denied. |
| 77 | `web/src/__tests__/api-mcp-servers-id-put.server.test.ts` | Shared route matrix for update; MCP origin and encrypted workspace credential tests | Positive candidate update and credential non-transfer remain. |
| 78 | `web/src/__tests__/api-mcp-servers-id-refresh.server.test.ts` | Shared route matrix for refresh; lifecycle audit rollback | Positive candidate refresh and atomic failure remain. |
| 79 | `web/src/__tests__/api-mcp-servers.server.test.ts` | Shared route matrix for install | Positive candidate install plus auth, bounds, validation, redaction, and no legacy spawn remain. |
| 80 | `web/src/__tests__/cap-expiry-flow.server.test.ts` | Banner/auth/404; exact-release renewal refusal | Configurable TTL/Never issuance is C3. |
| 81 | `web/src/__tests__/extension-author-install.server.test.ts` | Retired draft install refusals; extension-control, source import, candidate verification, and isolated definition tests | Positive v4 flow is separate. Child install and destructive draft move are C2/C4. |
| 82 | `web/src/__tests__/extension-author-page-logic.server.test.ts` | Safe filename/prefill/edit tests; author component and lifecycle verification tests | Positive immutable edit/build/verify path remains. |
| 83 | `web/src/__tests__/extensions-api.test.ts` | List/read/disable/uninstall positives; auth/redaction/refusal matrix; source import and exact approval tests | Purge and generic update are C4/C5. |
| 84 | `web/src/__tests__/extensions-reapprove-route.server.test.ts` | TTL renewal refusal and MCP redaction; lifecycle exact approval | Custom TTL/Never issuance is C3. |

Runner assignment: rows 54–74 are in both Bun pass/fail and host coverage pools. Rows 75–82 and 84 match Vitest's `*.server.test.ts` include and the V8 coverage producer. Row 83 is in `web_bunleg_files`, so `scripts/test-web.sh` gates its assertions; it is not incorrectly claimed as a Vitest suite.
