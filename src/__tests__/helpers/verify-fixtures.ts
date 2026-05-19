// Fixture helpers for Phase B `verifyExtension` integration tests.
//
// Builds REAL on-disk extension packages with a working stdio
// JSON-RPC tool server (the same shape the SDK scaffold emits, minus
// the `@ezcorp/sdk` import so the fixture is fully hermetic). Each
// fixture lives in a unique tmp dir — Bun caches `ezcorp.config.ts`
// by path, so reusing a path would return a stale manifest.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface VerifyFixture {
  dir: string;
  cleanup: () => void;
}

interface BuildOpts {
  name?: string;
  /** Override / omit the smokeTest block entirely. */
  smokeTest?: Record<string, unknown> | null;
  /** When true, the ping tool returns `isError: true`. */
  pingErrors?: boolean;
  /** When true, ping echoes a different payload (assertion-mismatch). */
  pingText?: string;
  /** Override manifest (escape hatch for invalid-manifest test). */
  rawConfig?: string;
}

const PING_INPUT = { message: "hello harness" } as const;

/**
 * A working stdio JSON-RPC tool server. Mirrors the SDK scaffold's
 * `toolEntrypoint` loop (line-delimited JSON, `handleRequest`).
 */
function entrypoint(pingErrors: boolean, pingText: string | undefined): string {
  // Default ping emits PRETTY-printed JSON so `"ok": true` (with the
  // post-colon space) is a literal substring — this mirrors the
  // canonical harness-smoke-test fixture's contract in Phase E.
  const payload = pingText !== undefined
    ? JSON.stringify(pingText)
    : 'JSON.stringify({ ok: true, echo: args.message ?? "" }, null, 2)';
  const isError = pingErrors ? "true" : "false";
  // NOTE: must use Bun.stdout.writer()+flush(), NOT process.stdout.write
  // — Phase 3's sandbox-preload poisons node:fs and Bun's lazy stdio
  // init for process.stdout reaches into fs internals on first call,
  // surfacing as "Transport closed". Mirrors helpers/mock-extension.
  return `#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = "";
const stdoutWriter = Bun.stdout.writer();

async function main() {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const res = handleRequest(req);
        if (res) {
          stdoutWriter.write(JSON.stringify(res) + "\\n");
          await stdoutWriter.flush();
        }
      } catch {}
    }
  }
}

function handleRequest(req) {
  if (req.method === "tools/call") {
    const args = req.params?.arguments ?? {};
    if (req.params?.name === "ping") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: ${payload} }],
          isError: ${isError},
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: "Unknown tool: " + req.params?.name },
    };
  }
  return null;
}

main();
`;
}

function config(name: string, smokeTest: Record<string, unknown> | null | undefined): string {
  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    name,
    version: "1.0.0",
    description: "Verify fixture extension",
    author: { name: "test" },
    entrypoint: "./index.ts",
    persistent: false,
    tools: [
      {
        name: "ping",
        description: "Echo back an ok envelope",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      },
    ],
    permissions: {},
  };
  if (smokeTest !== null && smokeTest !== undefined) {
    manifest.smokeTest = smokeTest;
  }
  return `export default ${JSON.stringify(manifest, null, 2)} as const;\n`;
}

export function buildVerifyFixture(opts: BuildOpts = {}): VerifyFixture {
  const name = opts.name ?? "verify-fx";
  const dir = mkdtempSync(join(tmpdir(), "verify-fx-"));

  if (opts.rawConfig !== undefined) {
    writeFileSync(join(dir, "ezcorp.config.ts"), opts.rawConfig);
  } else {
    const smoke =
      opts.smokeTest === null
        ? null
        : opts.smokeTest ?? {
            tool: "ping",
            input: PING_INPUT,
            expect: { textIncludes: '"ok": true' },
          };
    writeFileSync(join(dir, "ezcorp.config.ts"), config(name, smoke));
  }
  writeFileSync(
    join(dir, "index.ts"),
    entrypoint(opts.pingErrors ?? false, opts.pingText),
  );

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export { PING_INPUT };
