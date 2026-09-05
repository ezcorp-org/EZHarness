import { expect, test } from "bun:test";
import { connect } from "node:net";
import { startNativeProxy } from "./native-proxy";
import type { ExtensionContext } from "./index";

function context(call: ExtensionContext["call"], signal = new AbortController().signal): ExtensionContext {
  return { call, signal, invocation: { invocationId: "invocation", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 30_000 } };
}

async function send(proxy: string, path: string, authenticate = true, body?: string): Promise<{ status: number; body: string }> {
  const target = new URL(proxy);
  return new Promise((resolve, reject) => {
    const outgoing = connect({ host: target.hostname, port: Number(target.port) }, () => {
      outgoing.write(`${body ? "POST" : "GET"} ${path} HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n${authenticate ? `Proxy-Authorization: Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}\r\n` : ""}Content-Length: ${Buffer.byteLength(body ?? "")}\r\n\r\n${body ?? ""}`);
    });
    const chunks: Buffer[] = [];
    outgoing.on("data", bytes => chunks.push(Buffer.from(bytes)));
    outgoing.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const boundary = raw.indexOf("\r\n\r\n");
      const payload = raw.slice(boundary + 4);
      const decoded = /transfer-encoding: chunked/i.test(raw.slice(0, boundary)) ? payload.split("\r\n").filter((_part, index) => index % 2 === 1).join("") : payload;
      resolve({ status: Number(raw.match(/^HTTP\/1.1 (\d+)/)?.[1] ?? 0), body: decoded });
    });
    outgoing.on("error", reject);
  });
}

test("native HTTP uses only authenticated scoped broker requests and strips proxy credentials", async () => {
  const calls: unknown[] = [];
  const proxy = await startNativeProxy(context(async (method, input) => {
    calls.push({ method, input });
    return { status: 200, statusText: "OK", headers: { "x-fixture": "true" }, body: Buffer.from("broker response").toString("base64") };
  }));
  try {
    expect(proxy.environment.NO_PROXY).toBe("");
    expect(proxy.environment.ALL_PROXY).toBe("");
    expect(await send(proxy.environment.HTTP_PROXY!, "http://example.com/resource", false)).toEqual({ status: 407, body: "" });
    expect(calls).toHaveLength(0);
    expect(await send(proxy.environment.HTTP_PROXY!, "http://example.com/resource", true, "payload")).toEqual({ status: 200, body: "broker response" });
    expect(calls).toMatchObject([{ method: "ezcorp/network.fetch", input: { url: "http://example.com/resource", init: { method: "POST", body: Buffer.from("payload").toString("base64") } } }]);
    const headers = (calls[0] as { input: { init: { headers: Record<string, string> } } }).input.init.headers;
    for (const forbidden of ["host", "proxy-authorization", "connection", "content-length"]) expect(headers[forbidden]).toBeUndefined();
    for (const invalid of ["/relative", "file:///tmp/file", "http://user:password@example.com/", "http://example.com/#fragment"]) expect([0, 502]).toContain((await send(proxy.environment.HTTP_PROXY!, invalid)).status);
    expect(calls).toHaveLength(1);
    expect([0, 502]).toContain((await send(proxy.environment.HTTP_PROXY!, "http://example.com/", true, "x".repeat(512 * 1024 + 1))).status);
    expect(calls).toHaveLength(1);
  } finally { await proxy.close(); await proxy.close(); }
});

test("proxy authentication is unique per invocation and cancellation closes listeners", async () => {
  const controller = new AbortController();
  const first = await startNativeProxy(context(async () => { throw new Error("policy denied"); }, controller.signal));
  const second = await startNativeProxy(context(async () => null));
  try {
    const wrong = new URL(second.environment.HTTP_PROXY!);
    const endpoint = new URL(first.environment.HTTP_PROXY!);
    wrong.port = endpoint.port;
    expect((await send(wrong.toString(), "http://example.com")).status).toBe(407);
    expect((await send(first.environment.HTTP_PROXY!, "http://example.com")).status).toBe(502);
    controller.abort();
    await first.close();
    await expect(send(first.environment.HTTP_PROXY!, "http://example.com")).rejects.toThrow();
    await expect(startNativeProxy(context(async () => null, controller.signal))).rejects.toThrow();
  } finally { await first.close(); await second.close(); }
});
