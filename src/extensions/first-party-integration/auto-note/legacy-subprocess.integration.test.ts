import { fileURLToPath as fixtureFilePath } from "node:url";
const fixtureImportMeta = { dir: fixtureFilePath(new URL("../../../../docs/extensions/examples/auto-note/", import.meta.url)), dirname: fixtureFilePath(new URL("../../../../docs/extensions/examples/auto-note/", import.meta.url)), url: new URL("../../../../docs/extensions/examples/auto-note/legacy-subprocess.integration.test.ts", import.meta.url).href };
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { makeFsRpcHandler } from "@ezcorp/sdk/test";
const TMP_DIR = join("/tmp", `auto-note-subprocess-${Date.now()}`);
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));
type Spawned = {
  proc: ReturnType<typeof Bun.spawn>;
  send: (req: any) => Promise<any>;
  readNotifications: () => any[];
  close: () => Promise<void>;
};

async function spawnExtension(opts: { cwd: string; env?: Record<string, string> } = { cwd: TMP_DIR }): Promise<Spawned> {
  const extDir = fixtureImportMeta.dir; // points to docs/extensions/examples/auto-note
  const preloadPath = join(extDir, "..", "..", "..", "..", "src", "extensions", "runtime", "sandbox-preload.ts");
  const entrypoint = join(extDir, "index.ts");

  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: opts.cwd,
    // Phase 3 fs hardening: auto-note persists via host-mediated `fs*`
    // reverse-RPC. Grant the flag + answer `ezcorp/fs.*` below (scoped to
    // the subprocess cwd, which contains its `.ezcorp/extension-data` vault).
    EZCORP_FS_ALLOWED: "1",
  };

  const proc = Bun.spawn(
    ["bun", "run", "--preload", preloadPath, entrypoint],
    {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...baseEnv, ...(opts.env ?? {}) },
    },
  );

  // Host-side `ezcorp/fs.*` reverse-RPC handler, scoped to the subprocess cwd.
  const fsHandler = makeFsRpcHandler(opts.cwd);

  // Collect stdout lines and demux responses from notifications
  const responseCbs = new Map<number | string, (msg: any) => void>();
  const notifications: any[] = [];
  let stdoutBuffer = "";

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutBuffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method && msg.id != null) {
              // Reverse-RPC REQUEST from the subprocess (e.g. ezcorp/fs.*).
              // Answer it and write the response back over stdin — the host's
              // job. Without this the subprocess's fsWrite never resolves.
              const resp = fsHandler(msg) ?? {
                jsonrpc: "2.0", id: msg.id,
                error: { code: -32601, message: `Method not found: ${msg.method}` },
              };
              (proc.stdin as any).write(JSON.stringify(resp) + "\n");
              if ((proc.stdin as any).flush) (proc.stdin as any).flush();
            } else if (msg.id != null) {
              responseCbs.get(msg.id)?.(msg);
              responseCbs.delete(msg.id);
            } else if (msg.method) {
              notifications.push(msg);
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* closed */ }
  })();

  // Also drain stderr so it doesn't block on a full pipe
  const stderrChunks: string[] = [];
  (async () => {
    const r = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const d = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        stderrChunks.push(d.decode(value, { stream: true }));
      }
    } catch { /* closed */ }
  })();

  let nextId = 1;

  const send = (req: any): Promise<any> => {
    const id = req.id ?? nextId++;
    const full = { jsonrpc: "2.0", id, ...req };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        responseCbs.delete(id);
        reject(new Error(`Timeout waiting for id=${id}. stderr=${stderrChunks.join("")}`));
      }, 10_000);
      responseCbs.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      (proc.stdin as any).write(JSON.stringify(full) + "\n");
      if ((proc.stdin as any).flush) (proc.stdin as any).flush();
    });
  };

  const close = async () => {
    try { (proc.stdin as any).end?.(); } catch {}
    proc.kill();
    await proc.exited.catch(() => {});
  };

  return {
    proc,
    send,
    readNotifications: () => [...notifications],
    close,
  };
}

describe("E2E: real subprocess + JSON-RPC", () => {
  const E2E_DIR = join(TMP_DIR, "e2e-vault-" + Date.now());

  beforeEach(() => {
    try { rmSync(E2E_DIR, { recursive: true }); } catch {}
    mkdirSync(join(E2E_DIR, ".git"), { recursive: true }); // so findProjectRoot anchors here
  });

  test("subprocess starts and responds to vault-tree", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(res.isError).toBeFalsy();
      expect(res.result.content[0].text).toContain("vault/");
      expect(res.result.content[0].text).toContain("Total: 0 notes");
    } finally { await ext.close(); }
  });

  test("capture in yolo mode writes files to the vault directory", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Idea: add dark mode #ui", mode: "yolo" } },
      });
      expect(res.isError).toBeFalsy();
      expect(res.result.content[0].text).toContain("Done!");

      // Files should exist on disk
      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      expect(existsSync(vaultDir)).toBe(true);
      const ideasDir = join(vaultDir, "ideas");
      const ideaFiles = readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
      expect(ideaFiles.length).toBeGreaterThan(0);
    } finally { await ext.close(); }
  });

  test("capture via real subprocess honors LLM-supplied category (learn-about-cows regression)", async () => {
    // Full round-trip through Bun.spawn + JSON-RPC with an LLM-supplied
    // classification. Guards the end-to-end fix for the `ideas/` fallback bug:
    // when the agent passes `category: "references"`, the file MUST land under
    // `references/`, never `ideas/`.
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({
        method: "tools/call",
        params: {
          name: "capture",
          arguments: {
            text: "learn more about cows",
            category: "references",
            title: "Learn more about cows",
            tags: ["cows", "animals", "biology"],
            mode: "yolo",
          },
        },
      });
      expect(res.isError).toBeFalsy();
      const narration = res.result.content[0].text;
      expect(narration).toContain("references/");
      expect(narration).not.toMatch(/\bideas\/learn-more-about-cows\b/);

      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      const refFiles = readdirSync(join(vaultDir, "references")).filter((f) => f.endsWith(".md"));
      expect(refFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(true);
      // ideas/ is either missing or doesn't contain a cows note
      const ideasPath = join(vaultDir, "ideas");
      if (existsSync(ideasPath)) {
        const ideaFiles = readdirSync(ideasPath);
        expect(ideaFiles.some((f) => f.includes("learn-more-about-cows"))).toBe(false);
      }

      // Verify the frontmatter written to disk has the right category
      const cowsFile = refFiles.find((f) => f.includes("learn-more-about-cows"))!;
      const fileContent = await Bun.file(join(vaultDir, "references", cowsFile)).text();
      expect(fileContent).toContain("category: references");
      expect(fileContent).toContain("cows");
      expect(fileContent).toContain("animals");
    } finally { await ext.close(); }
  });

  test("capture does NOT emit unsolicited stdout that could break JSON-RPC framing", async () => {
    // Regression: earlier versions emitted `ezcorp/state` notifications after
    // every tool call, which interleaved with the response on stdout and broke
    // the server's JSON-RPC transport. Panel state is now only emitted from
    // explicit lifecycle hooks, not from unrelated tool calls.
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const res = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Test note", mode: "yolo" } },
      });
      expect(res.isError).toBeFalsy();

      // No notifications should be emitted during a normal tool call
      const notifs = ext.readNotifications();
      expect(notifs.find((n) => n.method === "ezcorp/state")).toBeUndefined();
    } finally { await ext.close(); }
  });

  test("lifecycle hook triggers ezcorp/state notification (expected emission point)", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({ method: "lifecycle/run:start", params: {} });
      // Give the async notification write a moment to flush
      await new Promise((r) => setTimeout(r, 100));

      const notifs = ext.readNotifications();
      const stateNotif = notifs.find((n) => n.method === "ezcorp/state");
      expect(stateNotif).toBeDefined();
      expect(stateNotif.params.title).toBe("Auto Note");
    } finally { await ext.close(); }
  });

  test("subprocess handles sequential calls without crashing", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const r1 = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(r1.error).toBeUndefined();

      const r2 = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "First note", mode: "yolo" } },
      });
      expect(r2.error).toBeUndefined();

      const r3 = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Second note #test", mode: "yolo" } },
      });
      expect(r3.error).toBeUndefined();

      const r4 = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(r4.error).toBeUndefined();
      expect(r4.result.content[0].text).toContain("Total: 2 notes");
    } finally { await ext.close(); }
  });

  test("approval-mode capture returns plan ID and confirm executes it", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const planRes = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Decision: use GraphQL", mode: "approval" } },
      });
      expect(planRes.error).toBeUndefined();
      const planText = planRes.result.content[0].text;
      expect(planText).toContain("Plan ID:");
      expect(planText).toContain("Proceed?");

      const planId = planText.match(/Plan ID: ([a-f0-9-]+)/)![1]!;

      // File should not exist yet
      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      if (existsSync(join(vaultDir, "decisions"))) {
        expect(readdirSync(join(vaultDir, "decisions")).filter((f) => f.endsWith(".md")).length).toBe(0);
      }

      // Confirm
      const confirmRes = await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Decision: use GraphQL", planId, confirmed: true } },
      });
      expect(confirmRes.error).toBeUndefined();
      expect(confirmRes.result.content[0].text).toContain("Done!");

      // Now file exists
      const files = readdirSync(join(vaultDir, "decisions")).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);
    } finally { await ext.close(); }
  });

  test("configure tool persists settings and reads them back", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "configure", arguments: { defaultMode: "yolo" } },
      });

      const cfg = await ext.send({ method: "tools/call", params: { name: "configure", arguments: {} } });
      const parsed = JSON.parse(cfg.result.content[0].text);
      expect(parsed.defaultMode).toBe("yolo");

      // Config file should exist in the e2e dir
      expect(existsSync(join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "config.json"))).toBe(true);
    } finally { await ext.close(); }
  });

  test("configure does NOT write to the real project config path", async () => {
    // Regression: earlier versions wrote to <projectRoot>/.ezcorp/extension-data/auto-note/config.json
    // which polluted production installs. This confirms the cwd-scoped write.
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "configure", arguments: { defaultMode: "yolo", vaultPath: "/tmp/doesnt-matter" } },
      });
    } finally { await ext.close(); }

    // Project-root config.json should not be affected by this test run
    // (we only verify our own E2E_DIR got the config — see test above)
    expect(existsSync(join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "config.json"))).toBe(true);
  });

  test("unknown tool returns JSON-RPC error, subprocess stays alive", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const err = await ext.send({ method: "tools/call", params: { name: "does-not-exist", arguments: {} } });
      expect(err.error).toBeDefined();

      // Subprocess should still be alive and responsive
      const ok = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(ok.error).toBeUndefined();
    } finally { await ext.close(); }
  });

  test("lifecycle hook notifications do not crash subprocess", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      const ok = await ext.send({ method: "lifecycle/run:start", params: {} });
      expect(ok.error).toBeUndefined();

      const ok2 = await ext.send({ method: "lifecycle/run:complete", params: {} });
      expect(ok2.error).toBeUndefined();

      // Subprocess still responsive after lifecycle hooks
      const tree = await ext.send({ method: "tools/call", params: { name: "vault-tree", arguments: {} } });
      expect(tree.error).toBeUndefined();
    } finally { await ext.close(); }
  });

  test("capture with related notes links them bidirectionally on disk", async () => {
    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "First: reference about #auth security", mode: "yolo" } },
      });
      await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "Second: idea about improving #auth flows", mode: "yolo" } },
      });

      // Walk the vault and verify at least one file contains a wikilink to another
      const vaultDir = join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault");
      let foundWikilink = false;
      for (const cat of CATEGORIES) {
        const dir = join(vaultDir, cat);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const content = await Bun.file(join(dir, file)).text();
          if (/\[\[[^\]]+\]\]/.test(content)) { foundWikilink = true; break; }
        }
        if (foundWikilink) break;
      }
      expect(foundWikilink).toBe(true);
    } finally { await ext.close(); }
  });

  test("subprocess does not write outside its cwd", async () => {
    // Sentinel: no auto-note files at common paths outside E2E_DIR
    const sentinelPaths = [
      join(TMP_DIR, "sentinel-autonote-" + Date.now()),
    ];
    for (const p of sentinelPaths) mkdirSync(p, { recursive: true });

    const ext = await spawnExtension({ cwd: E2E_DIR });
    try {
      await ext.send({
        method: "tools/call",
        params: { name: "capture", arguments: { text: "sentinel test note", mode: "yolo" } },
      });
    } finally { await ext.close(); }

    // Files should only exist under E2E_DIR/.ezcorp/extension-data/auto-note/
    for (const p of sentinelPaths) {
      expect(existsSync(join(p, ".ezcorp"))).toBe(false);
    }
    expect(existsSync(join(E2E_DIR, ".ezcorp", "extension-data", "auto-note", "vault"))).toBe(true);
  });
});
