import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

import surfaceAudit from "../agents/surface-audit.agent";
import { runAudit, runScheduledAudit } from "../runtime/audit/run";
import { createFeature, addUserFile } from "../db/queries/features";
import { listLatestClassifications } from "../db/queries/feature-classifications";
import { projects, features } from "../db/schema";
import { eq } from "drizzle-orm";
import type { AgentContext, LogLevel } from "../types";

interface Harness {
  ctx: AgentContext;
  logs: { message: string; level?: LogLevel }[];
  prompts: { user: string; system: string }[];
  abort: AbortController;
}

/** Agent context whose LLM returns `reply` (or throws when it is an Error). */
function harness(reply: string | Error = "{}", input: Record<string, unknown> = {}): Harness {
  const logs: Harness["logs"] = [];
  const prompts: Harness["prompts"] = [];
  const abort = new AbortController();
  const ctx = {
    input,
    llm: {
      complete: async (messages: { content: string }[], opts: { system: string }) => {
        prompts.push({ user: messages[0]!.content, system: opts.system });
        if (reply instanceof Error) throw reply;
        return { text: reply };
      },
    },
    log: (message: string, level?: LogLevel) => logs.push({ message, level }),
    signal: abort.signal,
  } as unknown as AgentContext;
  return { ctx, logs, prompts, abort };
}

let root: string;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

async function seedProject(name: string, path: string): Promise<string> {
  const rows = await getTestDb().insert(projects).values({ name, path }).returning({ id: projects.id });
  return rows[0]!.id;
}

async function seedFeature(projectId: string, name: string, files: string[], description = ""): Promise<string> {
  const f = await createFeature({ projectId, name, description });
  for (const rel of files) await addUserFile(f.id, rel);
  return f.id;
}

async function classification(projectId: string, featureId: string) {
  return (await listLatestClassifications(projectId)).find((r) => r.featureId === featureId);
}

function report(path: string): string {
  return readFileSync(path, "utf8");
}

beforeEach(async () => {
  await setupTestDb();
  root = mkdtempSync(join(tmpdir(), "audit-run-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("surface-audit agent input checks", () => {
  test("rejects a missing projectId", async () => {
    const res = await surfaceAudit.execute(harness().ctx);
    expect(res).toEqual({ success: false, output: null, error: "Provide 'projectId' in input" });
  });

  test("rejects an unknown project", async () => {
    const res = await surfaceAudit.execute(harness("{}", { projectId: "nope" }).ctx);
    expect(res.error).toBe("Project nope not found");
  });

  test("rejects a project with an empty path", async () => {
    const id = await seedProject("pathless", "");
    const res = await surfaceAudit.execute(harness("{}", { projectId: id }).ctx);
    expect(res.error).toBe(`Project ${id} has no path`);
  });
});

describe("surface-audit agent run", () => {
  test("precheck-only feature skips the LLM, writes the report, and is cached on the next run", async () => {
    write("ext/ezcorp.config.ts", "export default {}");
    write("web/src/lib/components/ez/Panel.svelte", "<div/>");
    const projectId = await seedProject("My Project", root);
    await seedFeature(projectId, "notes", ["ext/ezcorp.config.ts", "web/src/lib/components/ez/Panel.svelte"]);

    const h = harness();
    const first = await surfaceAudit.execute({ ...h.ctx, input: { projectId } });
    expect(first.success).toBe(true);
    const out = first.output as Awaited<ReturnType<typeof runAudit>>;
    expect(out).toMatchObject({ featureCount: 1, cacheHits: 0, llmCalls: 0, truncated: false });
    expect(h.prompts).toHaveLength(0);
    expect(out.reportPath.startsWith(join(root, ".ezcorp", "audit-reports", "my-project-"))).toBe(true);
    expect(report(out.reportPath)).toContain("notes");
    expect(h.logs.at(-1)?.message).toContain("Audit complete: 1 verdicts (0 cached, 0 LLM)");

    const second = await runAudit(projectId, root, h.ctx);
    expect(second).toMatchObject({ featureCount: 1, cacheHits: 1, llmCalls: 0 });
  });

  test("LLM fills undecided surfaces, but a precheck verdict wins on conflict", async () => {
    write("packages/@ezcorp/sdk/src/notes.ts", "export function notes() {}\n");
    const projectId = await seedProject("p", root);
    const featureId = await seedFeature(projectId, "notes", ["packages/@ezcorp/sdk/src/notes.ts"], "Take notes");

    const h = harness(JSON.stringify({
      sdk: { exposed: false, evidence: "llm says no" },
      ezbutton: { exposed: true, evidence: "has a panel" },
      mcp: { exposed: "maybe" },
      rationale: "Notes are a page tool.",
    }));
    const res = await runAudit(projectId, root, h.ctx);

    expect(res.llmCalls).toBe(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]!.system).toContain("STRICT JSON only");
    expect(h.prompts[0]!.user).toContain("Feature: notes");
    expect(h.prompts[0]!.user).toContain("Description: Take notes");
    expect(h.prompts[0]!.user).toContain("--- packages/@ezcorp/sdk/src/notes.ts ---\nexport function notes() {}");

    const row = await classification(projectId, featureId);
    expect(row?.rationale).toBe("Notes are a page tool.");
    expect(row?.surfaces.sdk).toMatchObject({ exposed: true, via: "precheck" });
    expect(row?.surfaces.ezbutton).toEqual({ exposed: true, via: "llm", evidence: "has a panel" });
    // A non-boolean `exposed` is not a verdict: the surface keeps the precheck default.
    expect(row?.surfaces.mcp).toEqual({ exposed: false, via: "precheck", evidence: "no precheck signal" });
  });

  test("unparseable LLM output logs a warning and falls back to precheck verdicts", async () => {
    const projectId = await seedProject("p", root);
    const featureId = await seedFeature(projectId, "plain", ["src/missing.ts"]);

    const h = harness("```json\n{}\n```");
    const res = await runAudit(projectId, root, h.ctx);

    expect(res.llmCalls).toBe(1);
    expect(h.logs.some((l) => l.level === "warn" && l.message.startsWith("llmClassify: parse failed for plain"))).toBe(true);
    const row = await classification(projectId, featureId);
    expect(row?.rationale).toBe("");
    expect(row?.surfaces.ezbutton.via).toBe("precheck");
  });

  test("an LLM error is handled like bad output, so the run still completes", async () => {
    const projectId = await seedProject("p", root);
    await seedFeature(projectId, "plain", []);

    const h = harness(new Error("rate limited"));
    const res = await runAudit(projectId, root, h.ctx);

    expect(res.featureCount).toBe(1);
    expect(h.logs.some((l) => l.level === "warn" && l.message.includes("rate limited"))).toBe(true);
  });

  test("the prompt lists at most 50 files and caps file headers at the byte budget", async () => {
    const big = `${"x".repeat(150)}\n`.repeat(80);
    const rels = Array.from({ length: 53 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    for (const rel of rels) write(rel, big);
    const projectId = await seedProject("p", root);
    await seedFeature(projectId, "wide", rels);

    const h = harness();
    await runAudit(projectId, root, h.ctx);

    const prompt = h.prompts[0]!.user;
    expect(prompt).toContain("Files (53):");
    expect(prompt).toContain("  … and 3 more");
    const headers = prompt.match(/^--- src\/f\d+\.ts ---$/gm) ?? [];
    // One 80-line head is ~12 KB, over the 8 KiB budget: only the first file fits.
    expect(headers).toEqual(["--- src/f00.ts ---"]);
  });

  test("an aborted run stops before the first feature and still reports truncation", async () => {
    const projectId = await seedProject("p", root);
    await getTestDb().insert(features).values(
      Array.from({ length: 501 }, (_, i) => ({ projectId, name: `f${i}` })),
    );

    const h = harness();
    h.abort.abort();
    const res = await runAudit(projectId, root, h.ctx);

    expect(res).toMatchObject({ featureCount: 0, truncated: true, llmCalls: 0 });
    expect(h.logs[0]!.message).toBe("Auditing 500 feature(s) in p (truncated from 501)");
    expect(h.logs.some((l) => l.level === "warn" && l.message === "Audit cancelled")).toBe(true);
    expect(report(res.reportPath)).toContain("Run truncated");
  });

  test("runAudit throws for an unknown project", async () => {
    await expect(runAudit("missing", root, harness().ctx)).rejects.toThrow("Project missing not found");
  });
});

describe("runScheduledAudit", () => {
  test("audits every project with a path and keeps going after one project fails", async () => {
    // A regular file as project root: writing the report under it fails.
    const brokenRoot = join(root, "not-a-dir");
    writeFileSync(brokenRoot, "");
    const good = join(root, "good");
    mkdirSync(good);
    await seedProject("pathless", "");
    await seedProject("broken", brokenRoot);
    await seedProject("good", good);

    await runScheduledAudit(harness().ctx);

    expect(existsSync(join(good, ".ezcorp", "audit-reports"))).toBe(true);
  });

  test("skips the seeded Global pseudo-project, whose path is the filesystem root", async () => {
    // Global is seeded with path "/". Point it at a temp dir to see whether
    // the sweep would write `<path>/.ezcorp/audit-reports` there.
    const globalRoot = join(root, "global-root");
    mkdirSync(globalRoot);
    await getTestDb().update(projects).set({ path: globalRoot }).where(eq(projects.id, "global"));

    await runScheduledAudit(harness().ctx);

    expect(existsSync(join(globalRoot, ".ezcorp"))).toBe(false);
  });

  test("stops at once when the signal is aborted", async () => {
    const good = join(root, "good");
    mkdirSync(good);
    await seedProject("good", good);

    const h = harness();
    h.abort.abort();
    await runScheduledAudit(h.ctx);

    expect(existsSync(join(good, ".ezcorp"))).toBe(false);
    expect(h.logs).toHaveLength(0);
  });
});
