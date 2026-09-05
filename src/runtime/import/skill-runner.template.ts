#!/usr/bin/env bun
/**
 * Generic skill-runner entrypoint (synthesized verbatim into an
 * imported Claude skill's extension dir as `index.ts`).
 *
 * A Claude skill is `SKILL.md` instructions + ad-hoc helper scripts —
 * it has no typed-tool surface, so we expose a fixed three-tool
 * shim over JSON-RPC 2.0 / stdio (same framing every EZCorp tool
 * extension uses):
 *
 *   skill_info   → returns the SKILL.md instructions
 *   list_scripts → enumerates the bundled script files
 *   run_script   → executes one bundled script (sandboxed by the host)
 *
 * The verbatim skill bundle lives in `./skill/` next to this file, so
 * `import.meta.dir` + "skill" is the (only) directory scripts may run
 * in. Every path the caller supplies is realpath-confined to it.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getInvocationContext, getInvocationSignal } from "@ezcorp/sdk/v4";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// The bundle normally lives in `./skill` next to this file. The env
// overrides are seams for in-process testing (and future relocation);
// resolved lazily so they honour the environment at call time.
function skillDir(): string {
  if (getInvocationContext()) return join(process.cwd(), "skill");
  return process.env.EZCORP_SKILL_DIR || join(import.meta.dir, "skill");
}
function skillMd(): string {
  return join(skillDir(), "SKILL.md");
}
function runTimeoutMs(): number {
  const value = Number(process.env.EZCORP_SKILL_RUN_TIMEOUT_MS);
  const limit = Math.max(1, Math.min(30_000, (getInvocationContext()?.deadline ?? Infinity) - Date.now()));
  return Number.isFinite(value) && value > 0 ? Math.min(value, limit) : limit;
}

const TOOLS = [
  {
    name: "skill_info",
    description:
      "Return this skill's full instructions (the SKILL.md body). Call this first to learn how to use the skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_scripts",
    description: "List the helper script/asset files bundled with this skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_script",
    description:
      "Run one bundled script from this skill. `script` is a path relative to the skill root; `args` are passed through.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Skill-relative script path" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["script"],
    },
  },
];

function ok(id: JsonRpcRequest["id"], text: string, isError = false): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } };
}
function rpcErr(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function listScripts(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > 32) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && childRel !== "SKILL.md") {
        out.push(childRel);
      }
    }
  }
  await walk(skillDir(), "", 0);
  return out.sort();
}

async function resolveScript(relInput: string): Promise<string | null> {
  if (typeof relInput !== "string" || relInput.length === 0) return null;
  if (relInput.startsWith("/") || /^[A-Za-z]:/.test(relInput)) return null;
  if (relInput.split(/[\\/]/).includes("..")) return null;
  const dir = skillDir();
  const target = resolve(join(dir, relInput));
  const realRoot = await realpath(dir);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) return null;
  let real: string;
  try {
    real = await realpath(target);
    if (!(await stat(real)).isFile()) return null;
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  return real;
}

export function commandFor(scriptPath: string, args: string[]): string[] {
  const lower = scriptPath.toLowerCase();
  if (lower.endsWith(".py")) return ["python3", scriptPath, ...args];
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".mjs"))
    return ["bun", scriptPath, ...args];
  if (lower.endsWith(".rb")) return ["ruby", scriptPath, ...args];
  if (lower.endsWith(".pl")) return ["perl", scriptPath, ...args];
  if (lower.endsWith(".sh") || lower.endsWith(".bash"))
    return ["bash", scriptPath, ...args];
  // No recognised extension: execute directly (relies on the exec bit
  // / shebang). The host sandbox still gates this.
  return [scriptPath, ...args];
}

async function runScript(
  rel: string,
  args: string[],
): Promise<{ text: string; isError: boolean }> {
  const real = await resolveScript(rel);
  if (!real) {
    return { text: `Script not found or outside the skill: ${rel}`, isError: true };
  }
  const signal = getInvocationSignal();
  signal?.throwIfAborted();
  const proc = Bun.spawn(commandFor(real, args), {
    cwd: skillDir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  let timedOut = false;
  let cancelled = false;
  let outputExceeded = false;
  let outputBytes = 0;
  const stop = () => {
    try { proc.kill(9); } catch {}
    for (const reader of readers) void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, runTimeoutMs());
  const cancel = () => { cancelled = true; stop(); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const grab = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = 65_536 - outputBytes;
        chunks.push(value.subarray(0, Math.max(0, remaining)));
        outputBytes += value.byteLength;
        if (outputBytes > 65_536) { outputExceeded = true; stop(); break; }
      }
    } finally { reader.releaseLock(); }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([proc.exited, grab(readers[0]!), grab(readers[1]!)]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }

  const header = timedOut
    ? `timed out after ${runTimeoutMs()}ms (exit ${exitCode})`
    : cancelled ? "cancelled" : outputExceeded ? "output limit exceeded (64 KiB)" : `exit ${exitCode}`;
  const body =
    `${header}\n` +
    (stdout ? `--- stdout ---\n${stdout}\n` : "") +
    (stderr ? `--- stderr ---\n${stderr}\n` : "");
  return { text: body.trim(), isError: timedOut || cancelled || outputExceeded || exitCode !== 0 };
}

export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } };
  }
  if (req.method !== "tools/call") {
    return rpcErr(req.id, -32601, `Unknown method: ${req.method}`);
  }
  const name = (req.params?.name as string) ?? "";
  const args = (req.params?.arguments as Record<string, unknown>) ?? {};

  if (name === "skill_info") {
    try {
      return ok(req.id, await Bun.file(skillMd()).text());
    } catch {
      return ok(req.id, "SKILL.md is missing from this skill bundle.", true);
    }
  }
  if (name === "list_scripts") {
    const scripts = await listScripts();
    return ok(
      req.id,
      scripts.length ? scripts.join("\n") : "(no script files in this skill)",
    );
  }
  if (name === "run_script") {
    const script = args.script as string;
    const passed = Array.isArray(args.args)
      ? (args.args as unknown[]).map(String)
      : [];
    const r = await runScript(script, passed);
    return ok(req.id, r.text, r.isError);
  }
  return rpcErr(req.id, -32601, `Unknown tool: ${name}`);
}

async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        const res = await handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch {
        // ignore malformed lines
      }
    }
  }
}

if (import.meta.main) {
  void main();
}
