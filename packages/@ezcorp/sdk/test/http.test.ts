// http.test.ts — fetchPermitted post-Phase-2 (thin shim)
//
// Phase 2 inverted the enforcement: the sandbox-preload's
// `globalThis.fetch` wrapper is now the gate. `fetchPermitted` is a
// `@deprecated` alias — it just calls `globalThis.fetch(url, init)` and
// hands the response (or the wrapper's throw) back to the caller.
//
// Tests below verify the alias semantics:
//   - Forwards positional args unchanged (URL, init)
//   - Returns whatever fetch returns (200, 500, etc.)
//   - Surfaces fetch's throw (including the wrapper's deny / size-cap
//     errors when run inside a sandboxed subprocess) without modification
//
// The wrapper's allowlist enforcement itself is tested in
// `src/__tests__/network-wrapper.test.ts` (pure logic) and
// `src/__tests__/security/sb2-network-egress.test.ts` (real preload
// subprocess). This file only verifies the SDK-side alias is correct.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { fetchPermitted } from "../src/runtime/http";

describe("fetchPermitted (thin shim of globalThis.fetch)", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("stub", { status: 200 })) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("forwards string URL to fetch verbatim", async () => {
    await fetchPermitted("https://api.example.com/v1/x");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] ?? [];
    expect(call[0]).toBe("https://api.example.com/v1/x");
  });

  test("forwards URL object to fetch verbatim", async () => {
    const u = new URL("https://api.example.com/hello");
    await fetchPermitted(u);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] ?? [];
    expect(call[0]).toBe(u);
  });

  test("forwards init second-arg unchanged", async () => {
    await fetchPermitted("https://api.example.com/", {
      method: "POST",
      headers: { "x-foo": "bar" },
      body: '{"k":"v"}',
    });
    const call = fetchSpy.mock.calls[0] ?? [];
    const init = call[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["x-foo"]).toBe("bar");
    expect(init?.body).toBe('{"k":"v"}');
  });

  test("init omitted → init forwarded as undefined (covers undefined branch)", async () => {
    await fetchPermitted("https://api.example.com/");
    const call = fetchSpy.mock.calls[0] ?? [];
    expect(call[1]).toBeUndefined();
  });

  test("returns the Response that fetch returns (200 OK)", async () => {
    const res = await fetchPermitted("https://api.example.com/");
    expect(res.status).toBe(200);
  });

  test("returns the Response that fetch returns (non-200 status echoes through)", async () => {
    fetchSpy.mockImplementation(
      (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch,
    );
    const res = await fetchPermitted("https://api.example.com/");
    expect(res.status).toBe(500);
  });

  test("surfaces fetch's throw without modification (wrapper-deny pass-through)", async () => {
    // Simulate the sandbox-preload wrapper's deny throw.
    fetchSpy.mockImplementation(
      (async () => {
        throw new Error(
          "Extension sandbox: hostname 'evil.com' is not in the granted network allowlist",
        );
      }) as unknown as typeof fetch,
    );
    await expect(fetchPermitted("https://evil.com/")).rejects.toThrow(
      /Extension sandbox: hostname 'evil\.com' is not in the granted network allowlist/,
    );
  });

  test("surfaces fetch's throw for upstream failures", async () => {
    fetchSpy.mockImplementation(
      (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    await expect(fetchPermitted("https://api.example.com/")).rejects.toThrow(
      /fetch failed/,
    );
  });
});
