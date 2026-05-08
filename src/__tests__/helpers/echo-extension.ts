// Minimal JSON-RPC extension that echoes back tool calls.
// Uses `Bun.stdout.writer()` rather than `process.stdout.write` because
// Phase 3 sandbox-preload poisons `node:fs` property access, and Bun's
// lazy stdio init for `process.stdout.write` triggers an fs property
// access that throws under the sandbox. `Bun.stdout` is unaffected.
const decoder = new TextDecoder();
const stdoutWriter = Bun.stdout.writer();

async function main() {
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const response = {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{ type: "text", text: `echo: ${req.method} ${JSON.stringify(req.params)}` }],
            isError: false,
          },
        };
        stdoutWriter.write(JSON.stringify(response) + "\n");
        await stdoutWriter.flush();
      } catch {}
    }
  }
}

main();
