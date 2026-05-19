/**
 * Phase 53.6 — fixture entrypoint for the boot-spawn regression test.
 *
 * Reads JSON-RPC newline-delimited frames from stdin. When a notification
 * with method `ezcorp/event/run:complete` arrives, echoes a notification
 * back to stdout (`test/received`) carrying the original payload's
 * `conversationId`. The host test asserts on the echoed notification
 * via `proc.setNotificationHandler`, proving the chain
 *   bootSpawnFlaggedBundledExtensions → ensureRunning → spawn →
 *   dispatcher.dispatch → proc.sendNotification → subprocess receives
 * works end-to-end with a real subprocess.
 *
 * Same `Bun.stdout.writer()` pattern as `helpers/mock-extension/entrypoint.ts`
 * (sandbox preload poisons `node:fs` access used by Bun's lazy stdio
 * init for `process.stdout.write`).
 */

const decoder = new TextDecoder();
let buffer = "";
const stdoutWriter = Bun.stdout.writer();

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

async function main() {
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const frame: JsonRpcEnvelope = JSON.parse(line);
        // Notifications: no `id`. We only care about run:complete.
        if (frame.method === "ezcorp/event/run:complete" && frame.id === undefined) {
          const params = frame.params ?? {};
          const conversationId = (params as { conversationId?: string }).conversationId;
          const echo: JsonRpcEnvelope = {
            jsonrpc: "2.0",
            method: "test/received",
            params: { conversationId, originalMethod: frame.method },
          };
          stdoutWriter.write(JSON.stringify(echo) + "\n");
          await stdoutWriter.flush();
        }
        // All other frames (including unknown methods) are silently
        // ignored — the fixture is a one-trick pony.
      } catch {
        // Malformed line — skip silently (mirrors mock-extension).
      }
    }
  }
}

main();
