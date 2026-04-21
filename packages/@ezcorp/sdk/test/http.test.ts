// http.test.ts — 100% line + branch coverage for runtime/http.ts
//
// Strategy: fetchPermitted has zero channel surface — just env + global
// fetch. Spy globalThis.fetch, toggle EZCORP_PERMITTED_HOSTS per test,
// assert throw-or-passthrough behavior. Restore env + fetch in afterEach.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { fetchPermitted } from "../src/runtime/http";

const SAVED_ENV = process.env.EZCORP_PERMITTED_HOSTS;

function setEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.EZCORP_PERMITTED_HOSTS;
  else process.env.EZCORP_PERMITTED_HOSTS = value;
}

describe("fetchPermitted", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("stub", { status: 200 })) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setEnv(SAVED_ENV);
  });

  // ── fail-closed when env absent / empty ────────────────────────

  test("throws fail-closed when EZCORP_PERMITTED_HOSTS is unset", async () => {
    setEnv(undefined);
    await expect(fetchPermitted("https://api.example.com/")).rejects.toThrow(
      /EZCORP_PERMITTED_HOSTS not configured — extension lacks granted network permission/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws fail-closed when EZCORP_PERMITTED_HOSTS is empty string", async () => {
    setEnv("");
    await expect(fetchPermitted("https://api.example.com/")).rejects.toThrow(
      /EZCORP_PERMITTED_HOSTS not configured/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws fail-closed when env filters to empty after trim/comma split", async () => {
    // readAllowlist() splits on "," then trims and filters length>0. Input
    // of only whitespace/commas yields [] → treated as "no permission".
    setEnv(" , , ,");
    await expect(fetchPermitted("https://api.example.com/")).rejects.toThrow(
      /not configured/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── hostname rejection ──────────────────────────────────────────

  test("rejects non-allowlisted hostname with message naming host + granted list", async () => {
    setEnv("api.example.com, foo.io");
    await expect(fetchPermitted("https://evil.tld/x")).rejects.toThrow(
      /hostname 'evil\.tld' is not in EZCORP_PERMITTED_HOSTS allowlist \(granted: api\.example\.com, foo\.io\)/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── passthrough branches ────────────────────────────────────────

  test("passes through to fetch when hostname is allowlisted (string URL)", async () => {
    setEnv("api.example.com");
    const res = await fetchPermitted("https://api.example.com/v1/x", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] ?? [];
    const url = call[0];
    const init = call[1] as RequestInit | undefined;
    expect(url).toBe("https://api.example.com/v1/x");
    expect(init?.method).toBe("POST");
  });

  test("accepts a URL object input and forwards it unchanged to fetch", async () => {
    setEnv("api.example.com");
    const u = new URL("https://api.example.com/hello");
    await fetchPermitted(u);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] ?? [];
    expect(call[0]).toBe(u);
  });

  test("passes through with init omitted (undefined init branch)", async () => {
    setEnv("api.example.com");
    await fetchPermitted("https://api.example.com/");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] ?? [];
    expect(call[1]).toBeUndefined();
  });

  // ── case normalization ──────────────────────────────────────────

  test("normalizes allowlist entries to lowercase (Example.COM in env matches example.com URL)", async () => {
    setEnv("Example.COM");
    await fetchPermitted("https://example.com/");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("normalizes URL hostname to lowercase (EXAMPLE.com URL matches example.com allowlist)", async () => {
    setEnv("example.com");
    await fetchPermitted("https://EXAMPLE.com/");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("whitespace around allowlist entries is trimmed (leading/trailing spaces)", async () => {
    setEnv("  api.example.com  ,  other.io  ");
    await fetchPermitted("https://other.io/");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
