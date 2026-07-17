# EZCorp Feature Documentation

This directory is the feature reference for EZCorp — one doc per user-facing or
developer-facing capability, written for **engineers onboarding** to the
codebase and for **maintainers** who need a durable map of how a feature
actually works on disk.

Each doc follows the same shape so you always know where to look:

- **Intent** — what the feature is for and why it exists.
- **How it works** — the data path, schema, and control flow.
- **Usage** — how to drive it as a user, operator, or extension author.
- **Key files** — the exact source files that implement it.
- **Features it touches** — adjacent capabilities it depends on or feeds.
- **Related docs** — deeper specs elsewhere in `docs/`.
- **Notes & gotchas** — gotchas, invariants, and known sharp edges.

## How this is organized

Docs are grouped into six domain folders:

- **chat/** — the conversation substrate: threads, messages, runs, streaming, attachments, providers.
- **composer/** — the message-authoring surface: the mention grammar, slash/feature/lesson expansion, the Ez concierge, and the `/goal` autopilot.
- **orchestration/** — multi-actor coordination: agents, teams, modes, and workflows.
- **extensions/** — the extension ecosystem: SDK, runtime/RPC, sandbox, permissions, entities, Hub pages, scheduling, and the bundled catalog.
- **tools/** — capabilities the LLM invokes: built-in file/shell tools, web search, MCP servers, and other host-provided tools.
- **platform/** — cross-cutting infrastructure: projects, RBAC, settings, auth, audit, API security, the database, deployment, and remote testability.

## Feature index

### chat

- [Attachments](chat/attachments.md) — Multi-modal file uploads: capability-gated staging, MIME + magic-byte validation, on-disk storage under `.ezcorp/attachments/`, and per-model delivery into the LLM.
- [Context-Window Compaction](chat/context-compaction.md) — Per-model history trimming that runs before every LLM call so a long chat fits the model's context window instead of dead-ending on `context_length_exceeded`.
- [Conversations & Threading](chat/conversations.md) — Project-scoped conversations whose messages form a branching tree (edit/regenerate forks), with sub-conversations for agent runs and root-walk ownership.
- [Knowledge Base (RAG)](chat/knowledge-base.md) — Project-scoped uploaded documents chunked and locally embedded into a pgvector index, retrieved by cosine similarity and injected into each chat turn (as an uncached block, outside the cached system+tools prefix).
- [Persistent Memory](chat/persistent-memory.md) — Durable, project-scoped facts about a user, extracted from completed chats, locally embedded, and injected into future turns via hybrid retrieval under a token budget (kept out of the cached system prefix).
- [Providers & Models](chat/providers-and-models.md) — The credential-and-catalog layer: a layered credential resolver (OAuth / BYOK / env) with encryption at rest, a fused model registry, per-model capabilities, and friendly error translation.
- [Rewind, Checkpoint & A/B Retry](chat/rewind-branching-sessions.md) — A durable, pi-session-backed view of the message tree: rewind/checkpoint the branch to a past turn, retry an assistant turn as a same-role sibling, and have both survive a reload — without mutating any `parentMessageId`.
- [Runs Lifecycle & Active-Run Control](chat/runs-lifecycle.md) — Every chat turn or agent invocation is a tracked `AgentRun`, mirrored to DB so it can be resumed, cancelled mid-flight, idle-killed by a watchdog, and awaited by an external harness.
- [Streaming Chat Runtime](chat/streaming-runtime.md) — The per-turn execution engine: `AgentExecutor.streamChat` builds the prompt and a per-call pi-agent, bridges its events onto an EventBus, and fans them to the browser over a single authorized SSE pipe.

### composer

- [Mention Grammar (5 sigils)](composer/mention-grammar.md) — The structured-mention system: five sigils (`! @ / $ %`) that open autocomplete, insert atomic `<sigil>[kind:name]` tokens, render as chips, and resolve/expand server-side at prompt-build time.
- [Slash Commands](composer/slash-commands.md) — Reusable prompt templates addressable with `/name`, discovered from eight filesystem roots plus a per-user DB table, with `$ARGUMENTS`/`$N` substituted server-side while the raw token is persisted.
- [Feature Index ($ mentions)](composer/feature-index.md) — A per-project registry of named "features" (a description + a curated file list) referenced via `$[feature:name]`, expanded server-side into a plain-text system note.
- [Lessons Keeper](composer/lessons.md) — Auto-captured, reusable insights distilled from completed runs, surfaced via the `%[lesson:slug]` sigil and curated through a user → project → global visibility ladder.
- [/goal Autopilot](composer/goal-autopilot.md) — A conversation-scoped self-continuation loop: `/goal <condition>` arms a completion condition that a cheap model judges after every turn, re-prompting until satisfied.
- [Ez Concierge & Runtime Actions](composer/ez-concierge-and-actions.md) — `![EZ:name]` runtime-action tokens that fire silently host-side and render a result card, plus the locked per-user Ez concierge conversation and its non-mentionable tools.

### orchestration

- [Agents (Agent Configs)](orchestration/agents.md) — Reusable, persisted LLM templates (prompt, model, sampling, capabilities, input schema, attached extensions) that can be `![agent:Name]`-mentioned to spin up a scoped helper inside any chat.
- [Teams & Multi-Agent Orchestration](orchestration/teams.md) — A team `agentConfig` that, when `![team:Name]`-mentioned, becomes an orchestrator: it resolves member agents, injects a coordinator prompt, and exposes `invoke_agent` to spawn members as sub-conversations.
- [Modes](orchestration/modes.md) — Preset conversation "flavors": a system-prompt instruction (prepend / append / replace) plus a tool-access scope, selected per-conversation and applied server-side before every turn.
- [Workflows](orchestration/workflows.md) — Declarative graphs mixing agent, transform, and gate steps (with bounded per-step loops); the executor topo-sorts steps into parallel batches with fail-fast, loud-failure semantics.

### extensions

- [Extension Authoring & SDK](extensions/overview-and-authoring.md) — How a user-built extension is declared, scaffolded, tested, and shipped: a single `ezcorp.config.ts`, the `@ezcorp/sdk` package, a `bun src/cli.ts ext` dev loop, and a zero-LLM `verify` gate.
- [Extension Runtime & Reverse-RPC](extensions/runtime-and-rpc.md) — How EZCorp runs each extension as a sandboxed JSON-RPC-over-stdio subprocess: the host dispatches `tools/call`, the child calls back via permission-gated `ezcorp/*` reverse-RPC, and the registry manages process lifecycle.
- [Sandbox & Isolation](extensions/sandbox-and-isolation.md) — The OS-level confinement layer wrapping every untrusted spawn behind a capability-probed tier (bwrap › landlock › advisory) whose invariant is that `.ezcorp/data` (DB + JWT secret) is never reachable.
- [Extension Permissions & Grants](extensions/permissions-and-grants.md) — The Policy Decision Point that gates every privileged operation: capability subset checks, sensitive-cap prompts with always-allow scopes, hard-denies for the platform DB, supply-chain ceilings, and TTL grant expiry.
- [Extension Data, Storage & Entities](extensions/data-and-entities.md) — The three persistence surfaces: a gitignored project-filesystem convention, a server-authoritative encrypted key-value store, and `defineEntity` typed collections with a paginated table UI.
- [Per-Extension Settings](extensions/settings.md) — A declarative manifest `settings` schema rendered into a per-user config form, with values resolved `default < override`, clamped at write and read, and injected into every tool call.
- [Extension Scheduling & Loop SDK](extensions/scheduling-and-loops.md) — A TZ/DST-safe cron daemon (`ctx.schedule`) with at-most-once delivery, plus `defineLoop` — a declarative primitive collapsing the whole autonomous-loop lifecycle onto one trigger surface (cron | event | manual).
- [Extension Hub Pages](extensions/hub-pages.md) — Extensions contribute Hub tabs from a declarative, server-validated JSON component tree rendered to native Svelte — extension code never touches the DOM, so XSS is impossible by construction.
- [Canvas Cards & Dock](extensions/canvas-cards.md) — Custom interactive tool-result cards: a `cardType` routes a result to a Svelte component, a sandboxed iframe renders bidirectional `createCanvas` events, and `cardLayout: "dock"` floats cards in a persistent panel.
- [Message Toolbar Contributions](extensions/message-toolbar.md) — An extension point that adds a per-turn action icon to the chat message toolbar; clicking it POSTs a declared event to the host, which can append a forced-excluded follow-up turn.
- [Deterministic Extension Pre-processing](extensions/deterministic-preprocess.md) — Manifest `preprocessors` run a declared tool on matching attachments deterministically — no LLM decision — before the assistant turn: the result persists as a `preprocess-result` tool card and grounds the reply via a system note.
- [Marketplace](extensions/marketplace.md) — A public catalog of shareable agent configs: browse, search, filter, install (minting a private copy), rate, flag, version, and import/export — backed by four `marketplace_*` tables.
- [Bundled Extension Catalog](extensions/bundled-catalog.md) — The 24 first-party extensions EZCorp auto-installs on first boot — the default tool/agent/canvas surface, gated by a hardcoded per-extension capability ceiling.

### tools

- [Built-in File & Shell Tools](tools/builtin-file-tools.md) — The host-side toolset every project chat gets for free (`readFile`, `listFiles`, `editFile`, `shell`, `grep`, `glob`, …), path-contained to the project root and output-capped below the model's input ceiling.
- [Web Search](tools/web-search.md) — A shared, host-side web-search + URL-to-markdown reader exposed via `ctx.search`, with an SSRF egress guard, a keyless-by-default provider chain, a shared cache, and per-extension quota + policy.
- [MCP Server Integration](tools/mcp-servers.md) — Connect external Model Context Protocol servers (stdio / HTTP / SSE), cache their tool lists, and surface them as namespaced extension tools — with stdio servers spawned inside a layered sandbox.
- [Ask-User (Human-in-the-Loop)](tools/ask-user.md) — Lets the LLM pause a run mid-stream to ask the user a question (multiple-choice or free-text) and resume with the answer, via the auto-wired `ask-user` extension.
- [Daily Briefing](tools/daily-briefing.md) — An autonomous per-user agent that, on a cron schedule, mines recent conversations, memory, and open tasks into a short, actionable morning briefing conversation.
- [Import (Skills & Commands)](tools/import.md) — A preview→commit wizard that ingests an archive or directory, discovers Claude skill bundles and slash-commands, and installs them as DB user-commands and disabled tool extensions.
- [Preview / Port Exposure](tools/preview-port-exposure.md) — Safely exposes a container-internal dev server to the requesting user only, via a per-conversation OS boundary, a one-time consent step, and a separate-origin reverse proxy gated by a signed token.

### platform

- [Projects & Root Resolution](platform/projects.md) — Two "project" concepts: the user-facing project record (whose `path` parameterizes every file tool) and the host-internal install-root resolver (`getProjectRoot()`) used for bundled-extension discovery and the `$CWD` grant.
- [RBAC & Permission Modes](platform/rbac-and-permission-modes.md) — The three authorization layers: instance roles, team roles, and per-project tool permission modes (`ask`/`auto-edit`/`yolo`) that decide which built-in tool calls auto-run vs. pause.
- [Authentication & Sessions](platform/authentication.md) — Request-level identity: HS256 JWTs in a host-only cookie backed by revocable sessions with sliding refresh, plus Bearer API-key auth, all enforced once in `hooks.server.ts`.
- [API Security Helpers](platform/api-security.md) — The HTTP perimeter: bearer-token auth, scope gating, token-bucket rate limiting, payload caps, per-user quotas, SSRF/DNS-pinning URL validation, and the CORS / proxy / CSP headers.
- [Developer API Keys](platform/developer-api-keys.md) — Long-lived `ezk_*` bearer tokens — SHA-256-hashed, scoped, shown raw once — that let external harnesses, CI scripts, and tools drive a live instance without a browser session.
- [Settings System](platform/settings-system.md) — The instance-wide configuration store: a `settings` key→JSONB KV table behind an admin-only CRUD API with a secret-key deny-list, plus per-(user, extension) settings and a sub-routed Settings UI.
- [Admin Surfaces](platform/admin-surfaces.md) — The instance-operator control plane: dual-gated read-only telemetry APIs, user lifecycle management with agent-ownership transfer, marketplace moderation, and the admin dashboard UI.
- [Audit Log & Observability](platform/audit-and-observability.md) — Two record-keeping planes: a redaction-gated governance audit trail of every permission decision and SDK capability call, plus a lightweight per-turn performance/cost observability stream.
- [Database & Migrations](platform/database-and-migrations.md) — The durable storage layer: a dual-driver (PGlite / external Postgres) Drizzle stack fronting a boot-time idempotent `migrate()`, with snapshots, a migration circuit breaker, and a recovery-needed readiness state.
- [Deployment & Releases](platform/deployment-and-releases.md) — How EZCorp ships: a two-stage hardened Docker image, dev/prod Compose stacks, a tag-triggered release pipeline that verifies snapshot/rollback/upgrade, and an in-app update-check banner.
- [Development Lifecycle & Cheat-Proof Gates](platform/dev-lifecycle-and-gates.md) — The trunk-based branch → PR → required-checks → squash-merge → release flow, hardened by Bun-native coverage gates and an anti-tamper meta-check an autonomous agent cannot game.
- [Onboarding & Quickstart](platform/onboarding-quickstart.md) — The first-run path: a zero-user install bootstraps its first admin at `/setup`, a per-user welcome wizard at `/onboarding`, and a dismissable "Get Started" checklist polling `/api/quickstart`.
- [Remote Testability Contract](platform/remote-testability.md) — EZCorp is remotely controllable and deterministically testable: an API registry drives an OpenAPI contract, a fail-closed `/api/__test/**` surface scripts a mock LLM, and a CI meta-test ratchets it.

## Maintaining these docs

See [MAINTAINING.md](MAINTAINING.md) for the conventions on how to add a new
feature doc, update an existing one, and keep this index in sync.
