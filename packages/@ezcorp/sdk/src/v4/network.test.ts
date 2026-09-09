import { expect, test } from "bun:test";
import { getGrantedEnv, getInvocationContext, readGrantedCredential, withExtensionContext } from "./context";
import { brokeredFetch, installNetworkShim } from "./network";
import type { ExtensionContext } from "./index";

function context(call: ExtensionContext["call"], signal = new AbortController().signal): ExtensionContext {
  return { call, signal, invocation: { invocationId: "invocation", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 30_000 } };
}

test("raw credential helper is explicit, bounded and invocation-only", async () => {
  await expect(readGrantedCredential("GITHUB_TOKEN")).rejects.toThrow("active invocation");
  await withExtensionContext(context(async (method, input) => { expect(method).toBe("ezcorp/credentials.read"); expect(input).toEqual({ name: "GITHUB_TOKEN" }); return "reviewed-credential"; }), async () => {
    expect(await readGrantedCredential("GITHUB_TOKEN")).toBe("reviewed-credential");
    await expect(readGrantedCredential("DATABASE_URL")).rejects.toThrow("Unsupported");
  });
  for (const invalid of [42, "", "bad\nsecret", "x".repeat(16385)]) await withExtensionContext(context(async () => invalid), async () => { await expect(readGrantedCredential("GITHUB_TOKEN")).rejects.toThrow("response"); });
  await withExtensionContext(context(async () => null), async () => expect(await readGrantedCredential("GITHUB_TOKEN")).toBeNull());
});

test("credential handles are invocation scoped and never use process environment", async () => {
  expect(getInvocationContext()).toBeUndefined();
  await expect(getGrantedEnv("KEY")).rejects.toThrow("active invocation");
  const scoped = context(async (method, input) => { expect(method).toBe("ezcorp/env.get"); expect(input).toEqual({ name: "KEY" }); return "opaque:credential"; });
  await withExtensionContext(scoped, async () => {
    expect(getInvocationContext()).toEqual(scoped.invocation);
    expect(await getGrantedEnv("KEY")).toBe("opaque:credential");
    await expect(getGrantedEnv("bad-name")).rejects.toThrow("Invalid credential name");
  });
  await withExtensionContext(context(async () => null), async () => expect(await getGrantedEnv("KEY")).toBeNull());
  await withExtensionContext(context(async () => ({})), async () => { await expect(getGrantedEnv("KEY")).rejects.toThrow("response"); });
});

test("network calls broker headers and body and restore global fetch", async () => {
  await expect(brokeredFetch("https://example.com")).rejects.toThrow("active invocation");
  const previous = globalThis.fetch;
  const restore = installNetworkShim();
  try {
    expect(() => globalThis.fetch.preconnect("https://example.com")).toThrow("not supported");
    await withExtensionContext(context(async (method, input) => {
      expect(method).toBe("ezcorp/network.fetch");
      expect(input).toMatchObject({ init: { method: "POST", body: "aGVsbG8=" } });
      return { status: 200, statusText: "OK", headers: { "x-test": "yes" }, body: "d29ybGQ=" };
    }), async () => {
      const response = await fetch(new Request("https://example.com", { method: "POST", body: "hello" }));
      expect(await response.text()).toBe("world");
      expect(response.headers.get("x-test")).toBe("yes");
    });
  } finally { restore(); }
  expect(globalThis.fetch).toBe(previous);
});

test("network bodies larger than a control frame use bounded chunks", async () => {
  const data = Buffer.alloc(1_200_000, 42);
  let calls = 0;
  await withExtensionContext(context(async (method, input) => {
    if (method === "ezcorp/network.fetch") return { status: 200, statusText: "OK", headers: {}, bodyId: "body", bodyBytes: data.length };
    const { offset } = input as { offset: number };
    calls++;
    const end = Math.min(offset + 256 * 1024, data.length);
    return { body: data.subarray(offset, end).toString("base64"), done: end === data.length };
  }), async () => expect(Buffer.from(await (await brokeredFetch("https://example.com")).arrayBuffer())).toEqual(data));
  expect(calls).toBe(5);
});

test("invalid network responses, lengths and oversized requests fail closed", async () => {
  const valid = { status: 200, statusText: "OK", headers: {}, body: "" };
  for (const response of [null, [], { ...valid, status: 199 }, { ...valid, headers: { test: 1 } }, { ...valid, bodyId: "ambiguous" }, { ...valid, body: "!" }, { status: 200, statusText: "OK", headers: {}, bodyId: "", bodyBytes: 1 }]) {
    await withExtensionContext(context(async () => response), async () => { await expect(brokeredFetch("https://example.com")).rejects.toThrow(); });
  }
  for (const chunk of [{ body: "", done: false }, { body: "", done: true }, { body: "YWI=", done: true }, { body: "YQ==", done: "yes" }]) {
    await withExtensionContext(context(async method => method === "ezcorp/network.fetch" ? { status: 200, statusText: "OK", headers: {}, bodyId: "id", bodyBytes: 1 } : chunk), async () => { await expect(brokeredFetch("https://example.com")).rejects.toThrow(); });
  }
  await withExtensionContext(context(async () => valid), async () => { await expect(brokeredFetch("https://example.com", { method: "POST", body: "x".repeat(256 * 1024 + 1) })).rejects.toThrow("exceeds"); });
  await withExtensionContext(context(async () => ({ ...valid, status: 204 })), async () => expect(await (await brokeredFetch("https://example.com")).text()).toBe(""));
  const controller = new AbortController();
  controller.abort();
  await withExtensionContext(context(async () => valid, controller.signal), async () => { await expect(brokeredFetch("https://example.com")).rejects.toThrow(); });
});
