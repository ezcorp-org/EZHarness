// Test fixture: an extension subprocess that dies mid-call.
//
// It reads the first request (so the host's pending JSON-RPC callback is
// registered before we exit — avoids a register-after-close race), writes
// a distinctive line to stderr, then exits 1 WITHOUT ever emitting a
// JSON-RPC response. The host's pending request rejects with the opaque
// "Transport closed"; the ExtensionProcess crash-enrichment path replaces
// that with the redacted stderr tail. Uses `Bun.stderr.writer()` rather
// than `process.stderr.write` because the Phase 3 sandbox-preload poisons
// `node:fs` property access (see helpers/echo-extension.ts).
const stderrWriter = Bun.stderr.writer();

async function main() {
  const reader = Bun.stdin.stream().getReader();
  await reader.read();
  stderrWriter.write("MODULE_LOAD_FATAL: Cannot find module 'ghost-pkg-xyz'\n");
  await stderrWriter.flush();
  process.exit(1);
}

main();
