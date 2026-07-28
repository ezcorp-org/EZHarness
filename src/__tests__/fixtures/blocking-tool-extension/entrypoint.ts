/**
 * Fixture entrypoint for the "reload must not interrupt an in-flight
 * call" regression test.
 *
 * Reads newline-delimited JSON-RPC frames from stdin. A `tools/call`
 * request is PARKED — the response is withheld until a `test/release`
 * notification arrives — which lets the host test hold a real
 * host→subprocess call open across a `registry.reload()`, exactly the
 * shape of `installAuthoredDraft` reloading from inside its own
 * `ezcorp/drafts.install` reverse-RPC.
 *
 * Same `Bun.stdout.writer()` pattern as the sibling fixtures: the
 * sandbox preload poisons the `node:fs` access Bun's lazy stdio init
 * uses for `process.stdout.write`.
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
}

let parkedId: number | null = null;

function send(frame: JsonRpcEnvelope): Promise<number> {
  stdoutWriter.write(`${JSON.stringify(frame)}\n`);
  return stdoutWriter.flush();
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
      let frame: JsonRpcEnvelope;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // malformed line — skip (mirrors the sibling fixtures)
      }

      if (frame.method === "tools/call" && typeof frame.id === "number") {
        parkedId = frame.id;
        // Tell the host the call is now genuinely parked in the child.
        await send({ jsonrpc: "2.0", method: "test/parked" });
        continue;
      }

      if (frame.method === "test/release" && parkedId !== null) {
        const id = parkedId;
        parkedId = null;
        await send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "released" }] },
        });
      }
    }
  }
}

main();
