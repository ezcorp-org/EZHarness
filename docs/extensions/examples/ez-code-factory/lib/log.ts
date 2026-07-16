// ── sandbox-safe stderr logging ──────────────────────────────────────
//
// This extension loads inside EZCorp's Phase-3 sandboxed subprocess, where the
// `node:fs` module is poisoned — any property access throws
// `Extension sandbox: 'fs module' blocked`. `process.stderr.write` triggers
// Bun's lazy `node:fs` WriteStream construction for stdio init, so the very
// first call throws and crashes the subprocess on start (bug B1: every log site
// used `process.stderr.write`, so the extension died before registering).
//
// `Bun.stderr` is a stable Bun primitive that is NOT gated by the fs poison —
// the same guarantee the SDK relies on for `Bun.stdout.writer()` in
// packages/@ezcorp/sdk/src/runtime/channel.ts ("Bun.stdout is a stable Bun
// primitive … so its writer survives the sandbox"). Its writer survives the
// sandbox, so ALL extension logging routes through `logLine` here. Logs stay on
// stderr (never stdout) so the JSON-RPC channel on stdout is left untouched.

let writer: ReturnType<typeof Bun.stderr.writer> | null = null;

/** The default sink: the sandbox-safe Bun stderr writer, created lazily and
 *  cached (writer construction is not free and the sandbox never revokes it). */
function bunStderrSink(line: string): void {
  if (!writer) writer = Bun.stderr.writer();
  writer.write(line);
  // Best-effort flush — mirrors channel.ts; back-pressure the next call rather
  // than await here (the host reader is line-delimited so framing is preserved).
  void writer.flush();
}

let sink: (line: string) => void = bunStderrSink;

/** Write one line to the subprocess's stderr via the sandbox-safe sink (a
 *  trailing newline is appended). Never routes through `process.stderr` — that
 *  is precisely what crashes the poisoned subprocess. */
export function logLine(message: string): void {
  sink(`${message}\n`);
}

/** Test seam: swap the stderr sink for a collector; pass `null` to restore the
 *  sandbox-safe default. Kept here (rather than a `process.stderr` spy) because
 *  the production sink deliberately bypasses `process.stderr`. */
export function _setLogSinkForTests(fn: ((line: string) => void) | null): void {
  sink = fn ?? bunStderrSink;
}
