# Phase 52 — UI verification matrix

This document is the verification log for v1.3 Phase 52 (Library
tabs + Audit drill-downs + In-chat pills + Settings). Each row is a
test artifact; together they cover every numbered sub-phase task.

## Coverage matrix

| Sub-phase | Surface | Test file | Runner | Tests |
|---|---|---|---|---|
| 52.1 | `listExtensions({bundled})` filter | `src/__tests__/extensions-list-bundled-filter.test.ts` | bun | 5 |
| 52.1 | `library-tabs` localStorage helper | `web/src/__tests__/library-tabs.test.ts` | bun | 8 |
| 52.1 | `/extensions` SSR loader | `web/src/__tests__/extensions-page-loader.server.test.ts` | vitest | 3 |
| 52.1 | `/extensions` library tabs UI | `web/e2e/extensions-library-tabs.spec.ts` | playwright | 5 |
| 52.2 | Audit-merge fan-in | `src/__tests__/audit-merge.test.ts` | bun | 10 |
| 52.2 | `/api/extensions/[id]/audit` | `web/src/__tests__/api-extensions-id-audit.server.test.ts` | vitest | 8 |
| 52.2 | `/api/extensions/[id]/audit/stats` | `web/src/__tests__/api-extensions-id-audit-stats.server.test.ts` | vitest | 7 |
| 52.2 | Per-extension audit page | `web/e2e/extensions-audit-drilldown.spec.ts` | playwright | 5 |
| 52.3 | Conversation buckets logic | `web/src/__tests__/conversation-buckets.test.ts` | bun | 8 |
| 52.3 | `/api/conversations/[id]/audit` | `web/src/__tests__/api-conversations-id-audit.server.test.ts` | vitest | 8 |
| 52.3 | Per-conversation audit page | `web/e2e/conversation-audit-drilldown.spec.ts` | playwright | 1 |
| 52.4 | Global audit feed module | `src/__tests__/audit-global.test.ts` | bun | 7 |
| 52.4 | `/api/audit` + `/api/audit/stats` | `web/src/__tests__/api-audit.server.test.ts` | vitest | 9 |
| 52.4 | Global `/audit` admin page | `web/e2e/audit-global.spec.ts` | playwright | 2 |
| 52.5 | Pill visibility predicate | `web/src/__tests__/pill-visibility.test.ts` | bun | 13 |
| 52.5 | CapabilityEventPill component | `web/src/lib/components/__tests__/CapabilityEventPill.component.test.ts` | vitest | 8 |
| 52.5 | Pill payload + extension name | `src/__tests__/recordCapabilityCall-pill-extension-name.test.ts` | bun | 3 |
| 52.5 | Settings + chat integration | `web/e2e/capability-event-pills.spec.ts` | playwright | 3 |
| pre-existing | LLM context strips capability-event | `src/__tests__/load-history-capability-event-filter.test.ts` | bun | 3 |

**Totals:** 88 unit/integration/component/server-test cases + 16
Playwright e2e cases = **104 test cases** added or carried for
Phase 52.

## Open question resolutions (per spec)

1. **Stats strip cost calculation** — Implemented as estimate-based,
   with the recommended one-line "approximate; provider billing may
   differ" disclaimer beneath every stats strip (per-extension and
   global). Documented in
   `src/db/queries/audit-merge.ts:statsForExtension` +
   `src/db/queries/audit-global.ts:globalStats`.
2. **Audit page pagination cursor format** — `{ts: ISO, id: string}`
   composite, base64-url encoded. Stable ordering across drivers;
   `id` disambiguates same-millisecond rows; base64-url discourages
   URL hand-editing without forcing the client to know about the
   composite. Implemented in
   `src/db/queries/audit-merge.ts:encodeCursor / decodeCursor`,
   covered by `audit-merge.test.ts`. Garbled-cursor input is
   silently dropped to "no cursor" rather than 500-ing the page.

## Credentials sweep

Regex sweep against the new pages confirmed no fixture-shaped
credentials are rendered:
  - `/sk-[a-zA-Z0-9]{20,}/` — never present.
  - `/ANTHROPIC_API_KEY=[A-Za-z0-9_-]+/` — never present.
  - `/OPENAI_API_KEY=[A-Za-z0-9_-]+/` — never present.

Audit detail rows render the `before`/`after` payloads verbatim from
`sdk_capability_calls` — those columns are already redacted by
`recordCapabilityCall.ts` via `redactForAudit` BEFORE persistence.
The chat pill payload is similarly redacted at write time. The UI
trusts what the database stored; the redaction guarantee is in the
write path, not the read path.

## NOT in v1.3 (per spec, deliberate scope)

- Lessons-distiller / memory-extractor as bundled extensions — Phase 53.
- Phase 49 nav UX — separate phase.
- Trend-line charts (need ≥7 days of data) — v1.4.
- Free-text search with full-text indexes — v1.4.
- Diff viewer for memory/lessons before/after pair — v1.4 (data
  ready in `lessons_audit_log` for when demand surfaces).

## Sub-phase verification command quick reference

```sh
# Backend (bun) — Phase 52 only
bun test src/__tests__/audit-merge.test.ts \
         src/__tests__/audit-global.test.ts \
         src/__tests__/extensions-list-bundled-filter.test.ts \
         src/__tests__/recordCapabilityCall-pill-extension-name.test.ts \
         src/__tests__/load-history-capability-event-filter.test.ts

# Web vitest — Phase 52 only (must run from web/)
cd web && bunx vitest run \
  src/__tests__/extensions-page-loader.server.test.ts \
  src/__tests__/api-extensions-id-audit.server.test.ts \
  src/__tests__/api-extensions-id-audit-stats.server.test.ts \
  src/__tests__/api-conversations-id-audit.server.test.ts \
  src/__tests__/api-audit.server.test.ts \
  src/lib/components/__tests__/CapabilityEventPill.component.test.ts

# Web bun-test — Phase 52 only
cd web && bun test \
  src/__tests__/library-tabs.test.ts \
  src/__tests__/conversation-buckets.test.ts \
  src/__tests__/pill-visibility.test.ts

# Playwright — Phase 52 only
cd web && bunx playwright test \
  extensions-library-tabs.spec.ts \
  extensions-audit-drilldown.spec.ts \
  conversation-audit-drilldown.spec.ts \
  audit-global.spec.ts \
  capability-event-pills.spec.ts
```
