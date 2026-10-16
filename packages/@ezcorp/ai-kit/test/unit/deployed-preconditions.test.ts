// @ezcorp-host-integration
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

// The deployed-service suites (test/e2e) skip by name ONLY when a precondition is missing (team-lead's ruling, W4H-33).
// Each suite's `present` line is the one that could silently turn it into a never-running suite (a check that is always
// false always skips), so each is proved here: the suite runs as a child `bun test` against an in-process stub server.
// - precondition PRESENT and behaviour WRONG: the suite runs and FAILS, and prints no precondition skip;
// - precondition MISSING: the suite skips with its tracked reason.
// The shared skip path is _guard.ts skipUnless; these cases prove each call site's `present` line.
// Host integration (the marker on line 1): it drives the test/e2e suites, which the release snapshot leaves out, so the
// snapshot must leave this file out too; the isolated build cannot run it (W4H-33b). The ai-kit host leg still runs it.

const ROOT = join(import.meta.dir, "..", "..");
const TRACKED = "tracked: ai-kit-deployed-lane";

/** What the stub server holds; each case sets it. */
const world = { extensions: [] as Array<{ name: string }>, agents: [] as Array<Record<string, unknown>> };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/health") return Response.json({ ok: true });
    if (path === "/api/extensions") return Response.json(world.extensions);
    if (path === "/api/agent-configs") return Response.json(world.agents);
    // Wrong behaviour: the ai-kit tools omit spawn_chats, and creating a conversation fails.
    if (path === "/api/extensions/ai-kit/tools") return Response.json({ tools: [{ name: "spawn_agents" }, { name: "spawn_team" }, { name: "assign_task" }] });
    if (path === "/api/conversations") return Response.json({ error: "stub: broken" }, { status: 500 });
    return new Response("not stubbed", { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function runSuite(suite: string, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  // A host agent session hides passing and skipped lines; the child prints the plain report.
  const { CLAUDECODE: _agent, EZCORP_E2E_MODEL: _pin, ...inherited } = process.env;
  const child = Bun.spawn([process.execPath, "test", "--timeout", "10000", `./test/e2e/${suite}.test.ts`], {
    cwd: ROOT,
    env: { ...inherited, EZCORP_E2E_BASE_URL: server.url.origin, EZCORP_E2E_API_KEY: "stub-key", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}` };
}

describe("bundled: precondition 'ai-kit installed'", () => {
  test("present, behaviour wrong: the suite FAILS and does not skip", async () => {
    world.extensions = [{ name: "ai-kit" }];
    const { code, output } = await runSuite("bundled");
    expect(code).not.toBe(0);
    expect(output).toMatch(/\(fail\) e2e: bundled ai-kit > ai-kit's tools are reachable/);
    expect(output).not.toContain("skip: precondition");
  }, 60_000);

  test("missing: the suite skips with the tracked reason and nothing fails", async () => {
    world.extensions = [];
    const { code, output } = await runSuite("bundled");
    expect(code).toBe(0);
    expect(output).toContain(`skip: precondition ai-kit installed missing; ${TRACKED}`);
    expect(output).toMatch(/\b0 fail\b/);
    expect(output).not.toMatch(/\b[1-9]\d* pass\b/);
  }, 60_000);
});

describe("quickstart: precondition 'EZCORP_E2E_MODEL'", () => {
  test("present, behaviour wrong: the suite runs and FAILS, and does not skip", async () => {
    const { code, output } = await runSuite("quickstart", { EZCORP_E2E_MODEL: "ezcorp-mock/mock:stub" });
    expect(code).not.toBe(0);
    expect(output).toMatch(/\(fail\) e2e: quickstart > create conversation/);
    expect(output).not.toContain("skip: precondition");
  }, 60_000);

  test("missing: the suite skips with the tracked reason and nothing fails", async () => {
    const { code, output } = await runSuite("quickstart");
    expect(code).toBe(0);
    expect(output).toContain(`skip: precondition EZCORP_E2E_MODEL missing; ${TRACKED}`);
    expect(output).toMatch(/\b0 fail\b/);
  }, 60_000);
});

describe("fanout: preconditions 'agents researcher and writer', 'autoSpinUp team', 'an agent'", () => {
  const CASES = ["(a) parallel", "(b) ![team:", "(c) assign_task"];

  test("present, behaviour wrong: each of the three cases runs and FAILS, and none skips", async () => {
    world.agents = [
      { id: "11111111-1111-4111-8111-111111111111", name: "researcher" },
      { id: "22222222-2222-4222-8222-222222222222", name: "writer" },
      { id: "33333333-3333-4333-8333-333333333333", name: "crew", category: "team", references: { autoSpinUp: true } },
    ];
    const { code, output } = await runSuite("fanout");
    expect(code).not.toBe(0);
    for (const name of CASES) expect(output).toContain(`(fail) e2e: four fan-out mechanisms > ${name}`);
    expect(output).not.toContain("skip: precondition");
  }, 60_000);

  test("missing: each of the three cases skips with its tracked reason", async () => {
    world.agents = [];
    const { output } = await runSuite("fanout");
    for (const precondition of ["agents researcher and writer", "autoSpinUp team", "an agent"]) {
      expect(output).toContain(`skip: precondition ${precondition} missing; ${TRACKED}`);
    }
    for (const name of CASES) expect(output).toContain(`(skip) e2e: four fan-out mechanisms > ${name}`);
  }, 60_000);
});
