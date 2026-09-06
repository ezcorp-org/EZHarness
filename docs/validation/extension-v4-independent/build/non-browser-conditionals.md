# Non-browser conditional and exclusion inventory

The original immutable coverage archive (`ba9f8cfc…`) contains 75 `(skip)` records. After the final readiness-guard replacements, `final-default-skip-records-ea.tsv` contains **80 `(skip)` records: 68 named tests and 12 unnamed hook records**. The unnamed records are PostgreSQL 2, AI-kit 9, and orphan sweep 1. Aggregate `N skip` summary lines are excluded.

## Arithmetic and dispositions

| Group | `(skip)` records | Exact gate | Disposition | Next command |
|---|---:|---|---|---|
| PostgreSQL migration | 11 (9 tests, 2 hooks) | `!DATABASE_URL` | Closed by the exact whole-file disposable PostgreSQL run:23 pass,92 assertions, including all9 real driver assertions. | Replay the owned PostgreSQL procedure in [runtime closeout](../runtime/final-skip-closure.md). |
| Task-stack and Todo SDK | 10 | unconditional `describe.skip` on the retired helper | Legacy source execution stays disabled. The numbered mapping in runtime closeout identifies current real-process replacements. Added exact Task Stack lifecycle and Todo query cases pass; the parent repeats14 tests/76 assertions. | Keep current v4 process tests as the proof; do not restore the retired helper. |
| AI-kit live E2E | 27 (18 tests, 9 hooks) | Per-file URL/key/subprocess gates | Safe HTTP, valid-key, on-behalf-of, subprocess, direct chat fanout, assignment routing, and local-model quickstart pass. Automatic bundled tools and orchestration mention/team expectations remain product decisions under C5. | See [AI-kit gate audit](../policy/ai-kit-e2e-audit/README.md) for each actual result and owned replay. |
| Price live E2E | 4 | `EZCORP_E2E_NETWORK=1`; real PDP also needs `EZCORP_E2E_REAL_PDP=1` | All4 paths pass with actual providers, real DNS, installed v4 release and owned PGlite. External PostgreSQL is no longer a prerequisite. Parent independently reran the whole file:7 pass/33 assertions. | `EZCORP_E2E_NETWORK=1 EZCORP_E2E_REAL_PDP=1 bun test ./src/__tests__/price-chart.e2e.test.ts` |
| Preview Docker | 7 | `DOCKER_TEST=1` | Exact preview UID and dynamic-preview files pass7/7 with21 assertions in the production image; source is unchanged in the final replacement image. | Use the owned read-only image command in [browser skip inventory](../web/skips.md). |
| MCP/network/seccomp | 19 | Linux tools/capabilities, selected opt-ins, or generated BPF | Bwrap tmpfs/PID3 pass with explicit SYS_ADMIN and outer seccomp-unconfined test conditions. Compiled-filter effects pass. Audit rows remain unavailable; Stage2 includes unimplemented TODO bodies. These are not general kernel-isolation proof. | Platform owner: provide an isolated audit-capable Stage2 VM; sandbox owner: implement remaining TODO assertions. Exact tools and next checks are in runtime closeout. |
| Landlock complementary ABI guard | 1 | `test.if(!LANDLOCK_OK)` | The supported-kernel grant test passes; the opposite unsupported-kernel branch correctly skips here. | Use an ABI0 kernel to execute the complementary platform branch. |
| Marketplace isolation | 1 | `EZCORP_RUN_PODMAN_TESTS=1` | Closed by the exact opted-in case:1 pass,5 assertions. | `EZCORP_RUN_PODMAN_TESTS=1 bun test ./src/__tests__/marketplace-release-isolation.integration.test.ts` |
| **Total** | **80** | | `11 + 10 + 27 + 4 + 7 + 19 + 1 + 1 = 80` | |

## Original checkpoint skip records

The bullets below preserve the original 75-record checkpoint. Use `final-default-skip-records-ea.tsv` for the authoritative final 80-record inventory.

- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > (unnamed)
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > (unnamed)
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > a real 23505 unique-violation is recognized by isUniqueViolation
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > execute() wrapper normalizes bun-sql arrays to { rows }
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > initDb selected external mode (PGlite handle is null)
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > jsonb column round-trips as an object (mapToDriverValue identity fix)
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > migrate() built the schema on the real server
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > migrate() is idempotent under the advisory lock (second run is clean)
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > rawQuery binds params through the real $client.unsafe
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > repairDoubleEncodedJsonb runs and records its one-shot marker
- Host producer `450` — `src/__tests__/db-migration-postgres.test.ts` — external Postgres via Bun.sql (real server) > tx.execute() inside db.transaction() is normalized too, against the real driver
- Host producer `746` — `src/__tests__/marketplace-release-isolation.integration.test.ts` — isolated publish artifacts persist and rebuild from immutable marketplace source
- Host producer `769` — `src/__tests__/mcp-netns-integration.test.ts` — bwrap tmpfs isolation > 100 MB write to tmpfs fails with ENOSPC (size cap enforced)
- Host producer `769` — `src/__tests__/mcp-netns-integration.test.ts` — bwrap tmpfs isolation > no --unshare-pid: host PID matches mcpChild.pid
- Host producer `769` — `src/__tests__/mcp-netns-integration.test.ts` — bwrap tmpfs isolation > writes inside bwrap'd /tmp succeed AND are invisible on host
- Host producer `769` — `src/__tests__/mcp-netns-integration.test.ts` — seccomp log mode > seccomp log → MCP_SECCOMP_VIOLATION audit row
- Host producer `770` — `src/__tests__/mcp-netns-raw-socket-blocked.test.ts` — RC#1: raw-socket bypass closed at kernel level > [Task 2 + Plan 03] Bun.connect({hostname: '127.0.0.1', port: 22}) inside Stage 2 netns rejects with ENETUNREACH (NOT ECONNREFUSED)
- Host producer `781` — `src/__tests__/mcp-seccomp-enforce-integration.test.ts` — declared getpid is logged and undeclared io_uring_setup is denied in the production spawn envelope
- Host producer `782` — `src/__tests__/mcp-seccomp-profile.test.ts` — seccomp profile shape > mcp-seccomp.bpf exists and is non-empty
- Host producer `782` — `src/__tests__/mcp-seccomp-profile.test.ts` — seccomp profile shape > openSeccompBpfFd returns a usable FD when the .bpf is present (Linux)
- Host producer `788` — `src/__tests__/mcp-stage2-conntrack-soak.test.ts` — Stage 2 conntrack soak (RC#2 CI proxy) > scaled 4×100 synthetic load: max(count) < 0.5 * max + zero `nf_conntrack: table full` in dmesg
- Host producer `789` — `src/__tests__/mcp-stage2-ipv6-disabled.test.ts` — Stage 2 IPv6 leak guard (RC#3) > curl -6 https://example.com inside Stage 2 netns returns 'Network is unreachable'
- Host producer `789` — `src/__tests__/mcp-stage2-ipv6-disabled.test.ts` — Stage 2 IPv6 leak guard (RC#3) > negative control: curl -4 https://example.com via proxy SUCCEEDS in the same netns
- Host producer `790` — `src/__tests__/mcp-stage2-orphan-sweep.test.ts` — Stage 2 boot orphan veth sweep (RC#5) > (unnamed)
- Host producer `790` — `src/__tests__/mcp-stage2-orphan-sweep.test.ts` — Stage 2 boot orphan veth sweep (RC#5) > non-matching name `mcp-deadbeefXX` (14 chars) is NOT swept
- Host producer `790` — `src/__tests__/mcp-stage2-orphan-sweep.test.ts` — Stage 2 boot orphan veth sweep (RC#5) > pre-seeded mcp-deadbeef is swept + MCP_VETH_ORPHAN_SWEPT row fires count=1
- Host producer `790` — `src/__tests__/mcp-stage2-orphan-sweep.test.ts` — Stage 2 boot orphan veth sweep (RC#5) > zero orphans → row STILL fires with count=0 (operator-visibility contract)
- Host producer `795` — `src/__tests__/mcp-veth-bridge-integration.test.ts` — Stage 2 bridge + veth pair integration > [Plan 03] idempotent bridge create — calling ensureBridge twice produces a single br-ezcorp-mcp interface
- Host producer `795` — `src/__tests__/mcp-veth-bridge-integration.test.ts` — Stage 2 bridge + veth pair integration > [Task 2 + Plan 03] nft list table inet mcp-egress shows single allow-exception rule
- Host producer `795` — `src/__tests__/mcp-veth-bridge-integration.test.ts` — Stage 2 bridge + veth pair integration > cleanup: ip link delete <host-side> tears down both ends
- Host producer `795` — `src/__tests__/mcp-veth-bridge-integration.test.ts` — Stage 2 bridge + veth pair integration > veth pair create + move into PID-target netns succeeds
- Host producer `949` — `src/__tests__/preview-dynamic-e2e.docker.test.ts` — dynamic preview — LIVE e2e (DOCKER_TEST=1) > WS upstream (ws://127.0.0.1:<port>) connects + echoes a frame
- Host producer `949` — `src/__tests__/preview-dynamic-e2e.docker.test.ts` — dynamic preview — LIVE e2e (DOCKER_TEST=1) > reapPreviewConversation: REAL helper --kill actually reaps the tree + confirms
- Host producer `949` — `src/__tests__/preview-dynamic-e2e.docker.test.ts` — dynamic preview — LIVE e2e (DOCKER_TEST=1) > spawn as preview uid → ProcPortSource detects → loopback fetch 200
- Host producer `961` — `src/__tests__/preview-uid-keystone.docker.test.ts` — uid keystone — LIVE (DOCKER_TEST=1) > ProcPortSource attributes a live listener by its preview uid
- Host producer `961` — `src/__tests__/preview-uid-keystone.docker.test.ts` — uid keystone — LIVE (DOCKER_TEST=1) > helper refuses an out-of-range uid even invoked directly
- Host producer `961` — `src/__tests__/preview-uid-keystone.docker.test.ts` — uid keystone — LIVE (DOCKER_TEST=1) > preview uid CANNOT read .ezcorp/data (chmod 0700) — keystone
- Host producer `961` — `src/__tests__/preview-uid-keystone.docker.test.ts` — uid keystone — LIVE (DOCKER_TEST=1) > setuid helper present + 4755 root-owned in the image
- Host producer `965` — `src/__tests__/price-chart.e2e.test.ts` — price-chart e2e — chat-flow path (real PDP) > extensionToAgentTool.execute returns JSON payload (no sensitive-cap prompt)
- Host producer `965` — `src/__tests__/price-chart.e2e.test.ts` — price-chart e2e — live subprocess + network > get_crypto_chart(BTC) returns JSON with points + Bitcoin name
- Host producer `965` — `src/__tests__/price-chart.e2e.test.ts` — price-chart e2e — live subprocess + network > get_stock_chart(AAPL) returns JSON with points + no iframeSrc
- Host producer `965` — `src/__tests__/price-chart.e2e.test.ts` — price-chart e2e — through ToolExecutor (stub PDP) > ToolExecutor.executeToolCall returns JSON payload
- Host producer `1047` — `src/__tests__/sandbox-landlock-apply-coverage.test.ts` — landlock applyReadWriteJail — in-process grant body coverage > ABI guard: applyReadWriteJail throws on an unsupported kernel
- Host producer `1188` — `src/__tests__/task-stack-sdk-integration.test.ts` — task-stack SDK integration (createTestExtension + real RPC) > add-task → list-tasks round-trip through JSON-RPC + SDK storage wrapper
- Host producer `1188` — `src/__tests__/task-stack-sdk-integration.test.ts` — task-stack SDK integration (createTestExtension + real RPC) > list-stacks returns the default 'inbox' stack created by SDK-loaded store
- Host producer `1188` — `src/__tests__/task-stack-sdk-integration.test.ts` — task-stack SDK integration (createTestExtension + real RPC) > start-task → get-active-task → finish-task lifecycle round-trip
- Host producer `1188` — `src/__tests__/task-stack-sdk-integration.test.ts` — task-stack SDK integration (createTestExtension + real RPC) > storeTool mutex serializes concurrent add-task calls — no lost writes
- Host producer `1188` — `src/__tests__/task-stack-sdk-integration.test.ts` — task-stack SDK integration (createTestExtension + real RPC) > unknown tool returns isError:true without killing the subprocess (dispatcher surface)
- Host producer `1207` — `src/__tests__/todo-tracker-sdk-integration.test.ts` — todo-tracker SDK integration (createTestExtension + real RPC) > scan-todos discovers seeded TODO/FIXME/HACK markers
- Host producer `1207` — `src/__tests__/todo-tracker-sdk-integration.test.ts` — todo-tracker SDK integration (createTestExtension + real RPC) > scan-todos on empty dir reports no comments found
- Host producer `1207` — `src/__tests__/todo-tracker-sdk-integration.test.ts` — todo-tracker SDK integration (createTestExtension + real RPC) > scan-todos respects searchQuery filter through JSON-RPC args
- Host producer `1207` — `src/__tests__/todo-tracker-sdk-integration.test.ts` — todo-tracker SDK integration (createTestExtension + real RPC) > sequential scan-todos calls survive on the same process (dispatcher idempotence)
- Host producer `1207` — `src/__tests__/todo-tracker-sdk-integration.test.ts` — todo-tracker SDK integration (createTestExtension + real RPC) > unknown tool returns isError:true; dispatcher keeps subprocess alive
- Host producer `1433` — `src/extensions/first-party-integration/ai-kit/e2e/bundled.test.ts` — e2e: bundled ai-kit > ai-kit is registered as an installed extension
- Host producer `1433` — `src/extensions/first-party-integration/ai-kit/e2e/bundled.test.ts` — e2e: bundled ai-kit > ai-kit's tools are reachable via /api/extensions/ai-kit/tools
- Host producer `1433` — `src/extensions/first-party-integration/ai-kit/e2e/bundled.test.ts` — e2e: bundled ai-kit > sending ![ext:ai-kit] into a chat wires the tools
- Host producer `1434` — `src/extensions/first-party-integration/ai-kit/e2e/doctor.test.ts` — e2e: doctor > doctor reports failure for unreachable baseUrl
- Host producer `1434` — `src/extensions/first-party-integration/ai-kit/e2e/doctor.test.ts` — e2e: doctor > doctor reports ok when server is healthy + key is valid
- Host producer `1435` — `src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts` — e2e: four fan-out mechanisms > (a) parallel ![agent:…] mentions spawn concurrent sub-conversations
- Host producer `1435` — `src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts` — e2e: four fan-out mechanisms > (b) ![team:…] with autoSpinUp spawns every member
- Host producer `1435` — `src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts` — e2e: four fan-out mechanisms > (c) assign_task + start_assignment spawns a sub-conversation
- Host producer `1435` — `src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts` — e2e: four fan-out mechanisms > (d) spawn_chats — batch of 3 independent root conversations
- Host producer `1436` — `src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts` — e2e: internal-auth HTTP contract > a valid user-issued key still authenticates (no regression)
- Host producer `1436` — `src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts` — e2e: internal-auth HTTP contract > ezkint_ rejection and random-token rejection look IDENTICAL to the client (no prefix-based info leak)
- Host producer `1436` — `src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts` — e2e: internal-auth HTTP contract > forged ezkint_ token is rejected with 401 from the live server
- Host producer `1436` — `src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts` — e2e: internal-auth HTTP contract > random-garbage Bearer is rejected with 401 (baseline)
- Host producer `1437` — `src/extensions/first-party-integration/ai-kit/e2e/on-behalf-of.test.ts` — e2e: on-behalf-of header > user-issued keys ignore X-Ezcorp-On-Behalf-Of (no privilege bypass)
- Host producer `1438` — `src/extensions/first-party-integration/ai-kit/e2e/quickstart.test.ts` — e2e: quickstart > (unnamed)
- Host producer `1438` — `src/extensions/first-party-integration/ai-kit/e2e/quickstart.test.ts` — e2e: quickstart > create conversation → send message → stream until run:complete
- Host producer `1439` — `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` — e2e subprocess: full OBO chain with real stdio MCP > (unnamed)
- Host producer `1439` — `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` — e2e subprocess: full OBO chain with real stdio MCP > (unnamed)
- Host producer `1439` — `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` — e2e subprocess: full OBO chain with real stdio MCP > MCP client connects to subprocess and lists tools
- Host producer `1439` — `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` — e2e subprocess: full OBO chain with real stdio MCP > start_chat WITHOUT _meta → conversation owned by sys-ai-kit (baseline)
- Host producer `1439` — `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` — e2e subprocess: full OBO chain with real stdio MCP > start_chat with _meta.ezOnBehalfOf=geff → conversation owned by geff
- Host producer `1439` — `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` — e2e subprocess: full OBO chain with real stdio MCP > subprocess exits cleanly after client.close()

## Typecheck ratchet exclusions

The passing typecheck explicitly excluded 36 backend test files and 15 browser E2E files. These are typecheck exclusions, not runtime test skips.

### Backend tests (36)

- `src/integrations/github-projects/__tests__/client-core.test.ts`
- `src/integrations/github-projects/__tests__/progress.test.ts`
- `src/integrations/github-projects/__tests__/spawn.test.ts`
- `src/integrations/github-projects/__tests__/web-connect-flow.integration.test.ts`
- `src/__tests__/auth-layout-integration.test.ts`
- `src/__tests__/auth-layout.test.ts`
- `src/__tests__/await-run-completion.test.ts`
- `src/__tests__/briefing-api.test.ts`
- `src/__tests__/builtin-tool-watchdog-no-regression.integration.test.ts`
- `src/__tests__/chat-tool-loop-e2e.test.ts`
- `src/__tests__/db-migration-pg-trgm.test.ts`
- `src/__tests__/extension-runtime.test.ts`
- `src/__tests__/goal-host-db-helpers.test.ts`
- `src/__tests__/goal-host-unit.test.ts`
- `src/__tests__/host-maintenance-daemon.test.ts`
- `src/__tests__/host-maintenance-gin-sweep.test.ts`
- `src/__tests__/hub-api.test.ts`
- `src/__tests__/hub-render-pull.test.ts`
- `src/__tests__/json-rpc-streaming.test.ts`
- `src/__tests__/mcp-install-query.test.ts`
- `src/__tests__/mcp-netns-integration.test.ts`
- `src/__tests__/observability-collector.test.ts`
- `src/__tests__/openai-image-gen-2-watchdog-e2e.integration.test.ts`
- `src/__tests__/raw-query.test.ts`
- `src/__tests__/runtime-tools-edit-file.test.ts`
- `src/__tests__/runtime-tools-glob.test.ts`
- `src/__tests__/runtime-tools-list-files.test.ts`
- `src/__tests__/runtime-tools-read-directory.test.ts`
- `src/__tests__/runtime-tools-read-file.test.ts`
- `src/__tests__/runtime-tools-shell.test.ts`
- `src/__tests__/seam-observability-resilience-integration.test.ts`
- `src/__tests__/session-backfill-parity.test.ts`
- `src/__tests__/subscribe-bridge-cardlayout.test.ts`
- `src/__tests__/task-tracking-extension.test.ts`
- `src/__tests__/tool-executor-per-conversation-depth.test.ts`
- `src/__tests__/watchdog-tool-error-emission.integration.test.ts`

### Browser E2E specs (15)

- `web/e2e/agents-new.spec.ts`
- `web/e2e/agent-team-prepopulation.spec.ts`
- `web/e2e/conversation-tools-scope.spec.ts`
- `web/e2e/extensions-library-tabs.spec.ts`
- `web/e2e/extensions-mcp-edit.spec.ts`
- `web/e2e/extensions-mcp-tab.spec.ts`
- `web/e2e/extensions.spec.ts`
- `web/e2e/file-mentions.spec.ts`
- `web/e2e/inline-custom-card.spec.ts`
- `web/e2e/menu-keyboard-nav.spec.ts`
- `web/e2e/modes-extensions.spec.ts`
- `web/e2e/picker-pills.spec.ts`
- `web/e2e/task-card-actions-full.spec.ts`
- `web/e2e/tool-call-anchoring.spec.ts`
- `web/e2e/v1.3-permission-backbone.spec.ts`
