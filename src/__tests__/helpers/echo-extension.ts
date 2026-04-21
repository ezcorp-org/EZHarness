// Minimal JSON-RPC extension that echoes back tool calls
const decoder = new TextDecoder();

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
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch {}
    }
  }
}

main();
