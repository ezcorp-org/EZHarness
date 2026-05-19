/**
 * Phase 58 / MCP-05 — Raw-socket bypass probe fixture.
 *
 * Spawned by `src/__tests__/mcp-netns-raw-socket-blocked.test.ts` inside
 * a Stage 2 netns. Attempts a raw TCP connect to `127.0.0.1:22` (a port
 * unlikely to be open inside the namespace) and prints the error code
 * to stdout so the parent test can grep for `ENETUNREACH`.
 *
 *   - `ENETUNREACH` → kernel-level route absence (the Plan 02 contract).
 *   - `ECONNREFUSED` → route exists, port is closed (the bypass would
 *     have worked if a listener were up — Plan 02 contract violated).
 *   - Any other code → unexpected state; the parent test fails.
 *
 * Run via `bun tests/fixtures/raw-socket-probe/index.ts`.
 */

const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 22;

async function main(): Promise<void> {
  try {
    const conn = await Bun.connect({
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      socket: {
        data: () => {},
        open: () => {},
        close: () => {},
        error: () => {},
      },
    });
    // If we somehow reached here, the bypass worked — abort the
    // namespace with a distinctive marker so the parent test fails.
    console.log("RAW_SOCKET_CONNECTED_UNEXPECTEDLY");
    conn.end();
    process.exit(2);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Bun surfaces the syscall error code in the message (e.g.
    // `connect ENETUNREACH 127.0.0.1:22`). The parent regex-matches.
    console.log(`RAW_SOCKET_ERROR: ${msg}`);
    process.exit(0);
  }
}

void main();
