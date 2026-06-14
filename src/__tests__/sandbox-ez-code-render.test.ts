/**
 * REGRESSION GUARD — ez-code must not crash under the REAL sandbox preload.
 *
 * The bug this locks down: `docs/extensions/examples/ez-code/index.ts` used to
 * statically `import { copyFileSync, … } from "node:fs"` (for open_pr's
 * worktree file ops). In the REAL sandboxed subprocess, `sandbox-preload.ts`
 * ALWAYS poisons `node:fs` — so the import threw "Extension sandbox: 'fs
 * module' blocked" at MODULE-LOAD time. ez-code isn't `bootSpawn`, so the first
 * spawn is the dashboard render (`ezcorp/page.render`): module load crashed,
 * the subprocess exited 1, the JSON-RPC transport closed, and the Hub tab (plus
 * every tool) surfaced "Transport closed".
 *
 * The unit + e2e tests never caught it because they import `index.ts` directly
 * / use the SDK test channel — they NEVER run under `sandbox-preload.ts`. This
 * test closes that blind spot: it spawns the ez-code entrypoint EXACTLY the way
 * the host does (`bun run --preload <sandbox-preload> <entrypoint>` with the
 * host's env flags), then drives a real `ezcorp/page.render` over JSON-RPC and
 * asserts a valid dashboard tree comes back — no "fs module blocked", no
 * exit-1 crash.
 *
 * Reverse-RPC (the extension → host `ezcorp/storage` / `ezcorp/memory` reads
 * the dashboard makes) is answered here with empty results, since this test IS
 * the host side. A static-import guard (no `node:fs` / `node:child_process` in
 * the import graph) backs the runtime test up cheaply.
 */
import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../extensions/runtime/sandbox-preload.ts",
);
const EZ_CODE_ENTRYPOINT = resolve(
  import.meta.dir,
  "../../docs/extensions/examples/ez-code/index.ts",
);

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Spawn ez-code under the sandbox preload (host-faithful argv + env), send a
 * single host→extension JSON-RPC request, and resolve with the matching
 * response. Any reverse-RPC the extension issues (storage/memory reads) is
 * answered via `answerReverse`. Times out (kill + reject) after `timeoutMs`.
 */
async function renderUnderPreload(
  request: { id: number; method: string; params: unknown },
  answerReverse: (method: string, params: unknown) => unknown,
  timeoutMs = 15_000,
): Promise<{ response?: JsonRpcMsg; stderr: string; exitCode: number | null }> {
  // Mirror the host's spawn flags. ez-code holds `shell` + `network` +
  // `storage` permissions; the dashboard render path needs neither network nor
  // shell, but we set EZCORP_SHELL_ALLOWED=1 to match production (open_pr's
  // git/gh) and prove the module loads regardless. EZCORP_PROJECT_ROOT is the
  // repo root the host injects. EZCORP_FS_ALLOWED is informational only.
  const proc = Bun.spawn(
    ["bun", "run", "--preload", SANDBOX_PRELOAD_PATH, EZ_CODE_ENTRYPOINT],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        EZCORP_SHELL_ALLOWED: "1",
        EZCORP_NETWORK_ALLOWED: "1",
        EZCORP_PERMITTED_HOSTS: "api.github.com",
        EZCORP_FS_ALLOWED: "1",
        EZCORP_PROJECT_ROOT: process.cwd(),
      },
    },
  );

  const stdinWriter = (proc.stdin as { write(d: string): number; flush?(): void });
  let stderr = "";
  let response: JsonRpcMsg | undefined;
  let settled = false;

  const send = (msg: Record<string, unknown>) => {
    try {
      stdinWriter.write(JSON.stringify(msg) + "\n");
      stdinWriter.flush?.();
    } catch {
      /* stdin closed (child crashed) — the exit handler reports it */
    }
  };

  // Drain stderr so a poison/crash error is captured for the assertion.
  (async () => {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) stderr += dec.decode(value, { stream: true });
      }
    } catch {
      /* closed */
    }
  })();

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      finish();
    }, timeoutMs);

    // Read stdout line-by-line: dispatch the extension's reverse-RPC requests
    // and capture the response to OUR request id.
    (async () => {
      try {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (!line) continue;
            let msg: JsonRpcMsg;
            try {
              msg = JSON.parse(line) as JsonRpcMsg;
            } catch {
              continue; // non-JSON noise
            }
            // Extension → host reverse-RPC request (has both id + method).
            if (msg.method && msg.id !== undefined) {
              let result: unknown;
              let error: { code: number; message: string } | undefined;
              try {
                result = answerReverse(msg.method, msg.params);
              } catch (e) {
                error = { code: -32603, message: String(e) };
              }
              send(
                error
                  ? { jsonrpc: "2.0", id: msg.id, error }
                  : { jsonrpc: "2.0", id: msg.id, result },
              );
              continue;
            }
            // Response to OUR host→extension request.
            if (msg.id === request.id) {
              response = msg;
              clearTimeout(timer);
              try {
                proc.kill();
              } catch {
                /* already exiting */
              }
              finish();
              return;
            }
          }
        }
      } catch {
        /* stream closed */
      }
    })();

    proc.exited.then(() => {
      clearTimeout(timer);
      finish();
    });
  });

  // Give the channel a tick to install its handlers, then fire the request.
  await Bun.sleep(150);
  send({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });

  await done;
  const exitCode = await proc.exited.catch(() => null);
  return { response, stderr, exitCode };
}

describe("ez-code under the REAL sandbox preload (regression: node:fs poison crash)", () => {
  test("renders the dashboard page WITHOUT an fs-poison crash", async () => {
    // The dashboard render reads Storage("global") (runs) + Memory + tasks via
    // reverse-RPC. As the host side, answer them all with empty results so the
    // render produces the empty-state tree.
    const reverseCalls: string[] = [];
    const { response, stderr, exitCode } = await renderUnderPreload(
      { id: 1, method: "ezcorp/page.render", params: { pageId: "dashboard" } },
      (method, params) => {
        reverseCalls.push(method);
        if (method === "ezcorp/storage") {
          // Storage.get → `{ value }`; the run store reads `runs` (→ []).
          const op = (params as { op?: string } | undefined)?.op;
          if (op === "set") return { ok: true };
          return { value: null };
        }
        if (method === "ezcorp/memory") return []; // Memory.list → []
        return null;
      },
    );

    // The MUST: no fs-poison crash. Before the fix, the static `node:fs` import
    // threw at module-load → this string appeared in stderr + exit 1.
    expect(stderr).not.toContain("fs module' blocked");
    expect(stderr).not.toContain("Extension sandbox: 'fs module'");

    // A valid JSON-RPC result (a dashboard tree) came back — the module loaded,
    // the channel started, and the render handler ran. (A module-load crash
    // would yield NO response at all.)
    expect(response).toBeDefined();
    expect(response!.error).toBeUndefined();
    expect(response!.result).toBeDefined();

    // The rendered tree is the ez-code dashboard (empty state, no runs).
    const tree = JSON.stringify(response!.result);
    expect(tree).toContain("ez-code");

    // The render actually consulted the host (proves it ran the real handler).
    expect(reverseCalls).toContain("ezcorp/storage");

    // exitCode is from our kill (we tear the child down on response); the point
    // is the child stayed alive long enough to answer — not a load-time crash.
    expect(exitCode).not.toBeNull();
  }, 20_000);

  // Cheap backstop: the import graph must not statically reference a poisoned
  // module. (`node:os` and `node:path` are NOT poisoned and are allowed.) This
  // fails instantly if someone re-adds a `node:fs` / `node:child_process`
  // import to the ez-code entrypoint, even if the runtime test is skipped on a
  // constrained CI.
  test("ez-code entrypoint does NOT statically import a poisoned module", () => {
    const src = readFileSync(EZ_CODE_ENTRYPOINT, "utf8");
    // Strip line comments + block comments so the import-graph scan ignores the
    // explanatory prose that legitimately mentions `node:fs`.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    // Match real import/require of the poisoned builtins (with or without the
    // `node:` prefix).
    const poisoned = /(?:import\s[^;]*from\s*|require\s*\(\s*)["'](?:node:)?(?:fs|fs\/promises|child_process)["']/;
    expect(code).not.toMatch(poisoned);
  });
});
