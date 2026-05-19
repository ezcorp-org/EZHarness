import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write a trivial stdio MCP server to a temp file and return the command
 * spec the McpClient can use to spawn it. The server exposes a single
 * `echo` tool unless `toolName` is specified.
 */
export function makeStdioMcpServer(opts: { toolName?: string; tools?: Array<{ name: string; description: string }>; throwOnConnect?: boolean } = {}): {
  command: string;
  args: string[];
  scriptPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "mcp-fix-"));
  const scriptPath = join(dir, "server.ts");
  const tools = opts.tools ?? [{ name: opts.toolName ?? "echo", description: "Echo tool" }];

  if (opts.throwOnConnect) {
    // Exit immediately so `connect()` fails with a transport error
    writeFileSync(scriptPath, "process.exit(1);\n");
    return { command: "bun", args: ["run", scriptPath], scriptPath };
  }

  const toolsJson = JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    })),
  );

  writeFileSync(
    scriptPath,
    `
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          send({ jsonrpc: "2.0", id: req.id, result: {
            protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          } });
        } else if (req.method === "notifications/initialized") {
          // no-op
        } else if (req.method === "tools/list") {
          send({ jsonrpc: "2.0", id: req.id, result: { tools: ${toolsJson} } });
        } else if (req.method === "tools/call") {
          const text = req.params?.arguments?.text ?? "";
          send({ jsonrpc: "2.0", id: req.id, result: {
            content: [{ type: "text", text: "echoed:" + text }],
            isError: false,
          } });
        } else {
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
        }
      }
    });
    `,
  );
  return { command: "bun", args: ["run", scriptPath], scriptPath };
}
