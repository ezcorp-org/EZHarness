// Test fixture: an extension subprocess that dies mid-call WITHOUT writing
// anything to stderr. Reads the first request (so the host's pending
// callback is registered), then exits 1. The host's request rejects with
// the opaque "Transport closed" and — because the stderr tail is empty —
// the crash-enrichment path rethrows that original error verbatim rather
// than an enriched one.
async function main() {
  const reader = Bun.stdin.stream().getReader();
  await reader.read();
  process.exit(1);
}

main();
