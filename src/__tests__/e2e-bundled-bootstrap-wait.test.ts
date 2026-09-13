/**
 * The real-server global setups wait here before any spec builds. The wait
 * must ignore a staging burst that has not finished, fail closed when nothing
 * is ever staged or the builds never settle, and report the server's own
 * words when the status route is unavailable.
 */
import { describe, expect, test } from "bun:test";
import { waitForBundledBootstrap, type BundledBootstrapStatus } from "../../web/e2e/fixtures/bundled-bootstrap";

function fakeServer(sequence: Array<BundledBootstrapStatus | { status: number; body: string }>) {
  const calls: string[] = [];
  let clock = 0;
  const request = {
    async get(url: string) {
      calls.push(url);
      const next = sequence.length > 1 ? sequence.shift()! : sequence[0]!;
      const failure = "status" in next ? next : undefined;
      return {
        ok: () => failure === undefined,
        status: () => failure?.status ?? 200,
        text: async () => failure?.body ?? "",
        json: async () => next,
      };
    },
  };
  const options = { pollMs: 1_000, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  return { request, calls, options };
}

describe("waitForBundledBootstrap", () => {
  test("returns after two consecutive quiet polls, not on the first", async () => {
    const server = fakeServer([{ staged: 0, pending: 0 }, { staged: 12, pending: 9 }, { staged: 29, pending: 0 }, { staged: 29, pending: 1 }, { staged: 29, pending: 0 }, { staged: 29, pending: 0 }]);
    const result = await waitForBundledBootstrap(server.request, "http://server", server.options);
    expect(result).toEqual({ staged: 29, pending: 0, elapsedMs: 5_000 });
    expect(server.calls).toHaveLength(6);
    expect(server.calls[0]).toBe("http://server/api/__test/bundled-bootstrap");
  });

  test("fails closed when nothing is staged within the staging bound", async () => {
    const server = fakeServer([{ staged: 0, pending: 0 }]);
    await expect(waitForBundledBootstrap(server.request, "http://server", { ...server.options, stagingTimeoutMs: 3_000 })).rejects.toThrow(/No bundled installation was staged within 3000ms/);
  });

  test("fails closed when builds never settle within the settle bound", async () => {
    const server = fakeServer([{ staged: 29, pending: 4 }]);
    await expect(waitForBundledBootstrap(server.request, "http://server", { ...server.options, settleTimeoutMs: 4_000 })).rejects.toThrow(/did not settle within 4000ms \(4 pending across 29 installations\)/);
  });

  test("surfaces the route's own failure instead of polling through it", async () => {
    const server = fakeServer([{ status: 404, body: "Not found" }]);
    await expect(waitForBundledBootstrap(server.request, "http://server", server.options)).rejects.toThrow(/bundled bootstrap status failed \(404\): Not found/);
  });
});
