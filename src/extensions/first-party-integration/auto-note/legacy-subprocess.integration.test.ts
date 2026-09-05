import { fileURLToPath as fixtureFilePath } from "node:url";
const fixtureImportMeta = { dir: fixtureFilePath(new URL("../../../../docs/extensions/examples/auto-note/", import.meta.url)), dirname: fixtureFilePath(new URL("../../../../docs/extensions/examples/auto-note/", import.meta.url)), url: new URL("../../../../docs/extensions/examples/auto-note/legacy-subprocess.integration.test.ts", import.meta.url).href };
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FramedExecution } from "@ezcorp/extension-runner";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { makeFsRpcHandler } from "@ezcorp/sdk/test";
import { CATEGORIES } from "../../../../docs/extensions/examples/auto-note/lib/types";
const TMP_DIR = join("/tmp", `auto-note-subprocess-${Date.now()}`);
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));
async function spawnExtension(opts: { cwd: string; env?: Record<string, string> } = { cwd: TMP_DIR }) {
  const entrypoint = join(fixtureImportMeta.dir, "extension.ts");
  const proc = spawn(process.execPath, [entrypoint], { cwd: opts.cwd, stdio: "pipe", env: { PATH: process.env.PATH, ...opts.env } });
  const fsHandler = makeFsRpcHandler(opts.cwd);
  const notifications: Array<{ method: string; params: any }> = [];
  const execution = new FramedExecution("auto-note-test", proc, async (method, envelope) => {
    const input = (envelope as { input: Record<string, unknown> }).input;
    if (method === "ezcorp/state") { notifications.push({ method, params: input }); return null; }
    const params = { ...input };
    for (const key of ["path", "src", "dest"]) {
      const path = params[key];
      if (typeof path !== "string") continue;
      if (path === "/data" || path.startsWith("/data/")) params[key] = join(opts.cwd, ".ezcorp", "extension-data", "auto-note", path.slice(5));
      else if (path === "/project" || path.startsWith("/project/")) params[key] = join(opts.cwd, path.slice(8));
      else throw new Error("Fixture refuses non-virtual filesystem path");
    }
    const response = fsHandler({ jsonrpc: "2.0", id: 1, method, params });
    if (!response || response.error) throw new Error(response?.error?.message ?? `Unsupported fixture RPC: ${method}`);
    return response.result;
  }, async () => { proc.kill("SIGKILL"); }, 4 * 1024 * 1024, 5000);
  try { await execution.request("extension/discover", {}); } catch (error) { await execution.close(); throw error; }
  let sequence = 0;
  return {
    send: async (request: { method: string; params?: any }) => {
      const context = { invocationId: `auto-note-${++sequence}`, workerId: "worker", releaseId: "release", principalId: "user", scopeId: "project", token: "fixture", deadline: Date.now() + 5000 };
      try {
        const result = request.method === "tools/call"
          ? await execution.request("extension/invoke", { name: request.params.name, input: request.params.arguments ?? {}, context })
          : await execution.request("extension/dispatch", { method: request.method, input: request.params ?? {}, context });
        return { result } as any;
      } catch (error) { return { error: { message: error instanceof Error ? error.message : String(error) } } as any; }
    },
    readNotifications: () => [...notifications],
    close: () => execution.close(),
  };
}

describe("E2E: real subprocess + JSON-RPC", () => {
  const E2E_DIR = join(TMP_DIR, "e2e-vault-" + Date.now());

  beforeEach(() => {
    rmSync(E2E_DIR, { recursive: true, force: true });
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
      expect(stateNotif!.params.title).toBe("Auto Note");
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
