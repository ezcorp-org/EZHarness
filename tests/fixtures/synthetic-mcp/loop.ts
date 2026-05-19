#!/usr/bin/env bun
/**
 * Phase 58 / MCP-05 — Plan 58-03 — Synthetic MCP fixture for conntrack soak.
 *
 * Consumed by scripts/mcp-conntrack-soak-24h.sh (operator 24h fallback) and
 * src/__tests__/mcp-stage2-conntrack-soak.test.ts (CI 5-min proxy).
 *
 * Loops `fetch('http://example.com')` for N iterations, exiting 0 on success.
 * The destination is a stable HTTP-only host (no TLS handshake overhead in
 * the loop) — the goal is to generate conntrack entries proportional to
 * the absolute 20 × 1000 = 20k operator-scale criterion.
 *
 * Usage:  bun tests/fixtures/synthetic-mcp/loop.ts <N>
 * Default N: 100.
 *
 * Per-request body is discarded — only the TCP setup/teardown matters for
 * conntrack pressure. fetch() honors HTTP_PROXY env when injected by the
 * Stage 2 launcher.
 */

const N = Number.parseInt(process.argv[2] ?? "100", 10);

let ok = 0;
let fail = 0;
for (let i = 0; i < N; i++) {
  try {
    const r = await fetch("http://example.com", {
      // Short timeout so a slow proxy or dropped conn doesn't stall
      // the test/script for minutes.
      signal: AbortSignal.timeout(10_000),
    });
    // Consume the body to release the TCP socket.
    await r.text();
    ok += 1;
  } catch {
    fail += 1;
  }
}

process.stdout.write(`synthetic-mcp loop: ok=${ok} fail=${fail} total=${N}\n`);
// Exit 0 even on partial failure — the soak script asserts on conntrack
// counts + dmesg, not on the loop's success rate. A slow proxy or DNS
// hiccup shouldn't fail the soak harness.
process.exit(0);
