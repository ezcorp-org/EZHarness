import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveBundledExtensions } from "../extensions/bundled";

test.each([
  { terminal: "verified", expectedExit: 0 },
  { terminal: "failed", expectedExit: 1 },
])("production bootstrap subprocess returns $expectedExit for $terminal builds", async ({ terminal, expectedExit }) => {
  const directory = await mkdtemp(join(tmpdir(), "production-bootstrap-"));
  const cookie = join(directory, "session.cookie");
  const key = join(directory, "api.key");
  const controls: string[] = [];
  let polls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/extensions" && request.method === "GET") {
        polls += 1;
        return Response.json([]);
      }
      if (path === "/api/extensions/control" && request.method === "POST") {
        const { tool } = await request.json() as { tool: string };
        controls.push(tool);
        return Response.json({ operations: { build: {
          id: "build", kind: "build", state: polls === 1 ? "queued" : terminal,
          diagnostics: [], events: [], updatedAt: "2026-09-10T00:00:00.000Z",
        } } });
      }
      return new Response("Unexpected bootstrap request", { status: 404 });
    },
  });
  try {
    await writeFile(cookie, "localhost\tFALSE\t/\tFALSE\t0\tezcorp_session\tfixture-session\n");
    await writeFile(key, "fixture-api-key");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-shipping-bootstrap.ts")], {
      cwd: resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        EZ_PRODUCTION_ORIGIN: server.url.toString(),
        EZ_PRODUCTION_COOKIE_FILE: cookie,
        EZ_PRODUCTION_API_KEY_FILE: key,
        EZ_PRODUCTION_RECEIPT_DIR: directory,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect(exit).toBe(expectedExit);
      if (expectedExit !== 0) expect(stderr).toContain("Bundled bootstrap did not verify before the production proof");
      const receipt = join(directory, "bundled-bootstrap-initial.json");
      const evidence = JSON.parse(await readFile(receipt, "utf8"));
      const installations = resolveBundledExtensions().length;
      expect(evidence.initialPending).toBe(installations);
      expect(evidence.terminalOperationStates).toEqual({ [terminal]: installations });
      expect(new Set(controls)).toEqual(new Set(["extensions_inspect"]));
      expect(polls).toBe(3);
      expect((await stat(receipt)).mode & 0o777).toBe(0o600);
      expect(server.pendingRequests).toBe(0);
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
    }
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
