import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

// The deployed-service suites (test/e2e) skip by name ONLY when a precondition is missing (team-lead's ruling, W4H-33).
// This contract runs one of them, bundled.test.ts, as a child `bun test` against an in-process stub server:
// - precondition PRESENT (ai-kit installed) and behaviour WRONG (its tools omit spawn_chats): the suite must FAIL, and
//   print no precondition skip; a probe that skipped here would hide a real failure;
// - precondition MISSING: the suite skips with the tracked reason and nothing fails.

const ROOT = join(import.meta.dir, "..", "..");
const REASON = "skip: precondition ai-kit installed missing; tracked: ai-kit-deployed-lane";
let installed = true;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/health") return Response.json({ ok: true });
    if (path === "/api/extensions") return Response.json(installed ? [{ name: "ai-kit" }] : []);
    // Wrong behaviour: the four fan-out primitives must all be exposed, and spawn_chats is not.
    if (path === "/api/extensions/ai-kit/tools") return Response.json({ tools: [{ name: "spawn_agents" }, { name: "spawn_team" }, { name: "assign_task" }] });
    return new Response("not stubbed", { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function runBundled(): Promise<{ code: number; output: string }> {
  // A host agent session hides passing lines; the child prints the plain report.
  const { CLAUDECODE: _agent, ...inherited } = process.env;
  const child = Bun.spawn([process.execPath, "test", "--timeout", "10000", "./test/e2e/bundled.test.ts"], {
    cwd: ROOT,
    env: { ...inherited, EZCORP_E2E_BASE_URL: server.url.origin, EZCORP_E2E_API_KEY: "stub-key" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}` };
}

test("precondition present, behaviour wrong: the deployed-service suite FAILS and does not skip", async () => {
  installed = true;
  const { code, output } = await runBundled();
  expect(code).not.toBe(0);
  expect(output).toMatch(/\(fail\) e2e: bundled ai-kit > ai-kit's tools are reachable/);
  expect(output).not.toContain("skip: precondition");
}, 60_000);

test("precondition missing: the suite skips with the tracked reason and nothing fails", async () => {
  installed = false;
  const { code, output } = await runBundled();
  expect(code).toBe(0);
  expect(output).toContain(REASON);
  expect(output).toMatch(/\b0 fail\b/);
  expect(output).not.toMatch(/\b[1-9]\d* pass\b/);
}, 60_000);
