/**
 * The real-server global setups wait here before any spec builds. The wait
 * must count only unfinished build operations of live installations, ignore
 * a staging burst that has not finished, fail closed when nothing is ever
 * staged or the builds never settle, and report the server's own words when
 * the control API refuses.
 */
import { describe, expect, test } from "bun:test";
import { waitForBundledBootstrap, readBundledBootstrapStatus } from "../../web/e2e/fixtures/bundled-bootstrap";

type Snapshot = Array<{ id: string; uninstalled?: boolean; builds: string[]; other?: string[] }>;

function fakeServer(sequence: Array<Snapshot | { status: number; body: string }>) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  let clock = 0;
  let snapshot: Snapshot = [];
  const request = {
    async post(_url: string, { data }: { data: unknown }) {
      const { tool, input } = data as { tool: string; input: Record<string, unknown> };
      calls.push({ tool, input });
      if (tool === "extensions_workspace") {
        const next = sequence.length > 1 ? sequence.shift()! : sequence[0]!;
        if ("status" in next) return { ok: () => false, status: () => next.status, text: async () => next.body, json: async () => null };
        snapshot = next;
        return { ok: () => true, status: () => 200, text: async () => "", json: async () => snapshot.map(({ id, uninstalled }) => ({ id, uninstalled: uninstalled ?? false })) };
      }
      const entry = snapshot.find((candidate) => candidate.id === input.installationId)!;
      const operations = Object.fromEntries([
        ...entry.builds.map((state, index) => [`build-${index}`, { id: `build-${index}`, kind: "build", state }]),
        ...(entry.other ?? []).map((state, index) => [`activate-${index}`, { id: `activate-${index}`, kind: "activate", state }]),
      ]);
      return { ok: () => true, status: () => 200, text: async () => "", json: async () => ({ operations }) };
    },
  };
  const options = { pollMs: 1_000, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  return { request, calls, options };
}

describe("readBundledBootstrapStatus", () => {
  test("counts live installations and only their unfinished build operations", async () => {
    const server = fakeServer([[
      { id: "a", builds: ["queued", "verified"] },
      { id: "b", builds: ["building"], other: ["activating"] },
      { id: "c", builds: ["verifying"] },
      { id: "d", builds: ["failed", "cancelled"] },
      { id: "gone", uninstalled: true, builds: ["queued"] },
    ]]);
    expect(await readBundledBootstrapStatus(server.request, "http://server")).toEqual({ installations: 4, pending: 3 });
    expect(server.calls[0]).toEqual({ tool: "extensions_workspace", input: { action: "list" } });
    expect(server.calls.filter((call) => call.tool === "extensions_inspect").map((call) => call.input.installationId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("waitForBundledBootstrap", () => {
  test("returns after two consecutive quiet polls, not on the first", async () => {
    const server = fakeServer([
      [],
      [{ id: "a", builds: ["queued"] }, { id: "b", builds: ["queued"] }],
      [{ id: "a", builds: ["verified"] }, { id: "b", builds: ["verified"] }],
      [{ id: "a", builds: ["verified"] }, { id: "b", builds: ["queued"] }],
      [{ id: "a", builds: ["verified"] }, { id: "b", builds: ["verified"] }],
      [{ id: "a", builds: ["verified"] }, { id: "b", builds: ["verified"] }],
    ]);
    const result = await waitForBundledBootstrap(server.request, "http://server", server.options);
    expect(result).toEqual({ installations: 2, pending: 0, elapsedMs: 5_000 });
    expect(server.calls.filter((call) => call.tool === "extensions_workspace")).toHaveLength(6);
  });

  test("fails closed when nothing is staged within the staging bound", async () => {
    const server = fakeServer([[]]);
    await expect(waitForBundledBootstrap(server.request, "http://server", { ...server.options, stagingTimeoutMs: 3_000 })).rejects.toThrow(/No bundled installation was staged within 3000ms/);
  });

  test("fails closed when builds never settle within the settle bound", async () => {
    const server = fakeServer([[{ id: "a", builds: ["queued", "building"] }]]);
    await expect(waitForBundledBootstrap(server.request, "http://server", { ...server.options, settleTimeoutMs: 4_000 })).rejects.toThrow(/did not settle within 4000ms \(2 pending across 1 installations\)/);
  });

  test("surfaces the control API's own refusal instead of polling through it", async () => {
    const server = fakeServer([{ status: 403, body: "Insufficient scope" }]);
    await expect(waitForBundledBootstrap(server.request, "http://server", server.options)).rejects.toThrow(/extensions_workspace failed while waiting for the bundled bootstrap \(403\): Insufficient scope/);
  });
});
