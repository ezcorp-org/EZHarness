import { expect, test } from "bun:test";
import { BrowserCancellationUnconfirmed, invokeBrowserTool } from "../lib/extensions/browser-invocation";

const identity = { binding: "a".repeat(64), conversationId: "owned" };
const tool = { toolName: "allowed", input: { value: 1 } };
const ticket = { requestId: crypto.randomUUID(), installationId: "installation" };

test("uses a host-issued ticket and preserves exact tool and conversation", async () => {
  const bodies: unknown[] = [];
  const result = await invokeBrowserTool(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return Response.json(body.method === "prepare" ? ticket : { success: true });
  }, "/preview", identity, tool, new AbortController().signal);
  expect(result).toEqual({ success: true });
  expect(bodies).toEqual([{ ...identity, method: "prepare", ...tool }, { ...identity, method: "tool.invoke", requestId: ticket.requestId, ...tool }]);
});

test("cancellation while preparing cancels the issued ticket without dispatch", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  await expect(invokeBrowserTool(async (_url, init) => {
    const body = JSON.parse(String(init.body)); methods.push(body.method);
    if (body.method === "prepare") { controller.abort(); return Response.json(ticket); }
    expect(init.keepalive).toBe(true);
    expect(body).toEqual({ ...identity, method: "cancel", ...ticket });
    return Response.json({ state: "cancelled" });
  }, "/preview", identity, tool, controller.signal)).rejects.toThrow();
  expect(methods).toEqual(["prepare", "cancel"]);
});

test("aborting the HTTP call also sends one independent durable cancellation", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const methods: string[] = [];
  const result = invokeBrowserTool(async (_url, init) => {
    const body = JSON.parse(String(init.body)); methods.push(body.method);
    if (body.method === "prepare") return Response.json(ticket);
    if (body.method === "cancel") { expect(init.signal?.aborted).toBe(false); return Response.json({ state: "cancel_requested" }); }
    started.resolve();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("request aborted")), { once: true }));
  }, "/preview", identity, tool, controller.signal);
  void result.catch(() => undefined);
  await started.promise;
  controller.abort();
  await expect(result).rejects.toThrow("aborted");
  expect(methods).toEqual(["prepare", "tool.invoke", "cancel"]);
});

test("unconfirmed cancellation is explicit rather than false success", async () => {
  for (const reply of [new Response("denied", { status: 403 }), Response.json({ state: "invalid" })]) {
    const controller = new AbortController();
    await expect(invokeBrowserTool(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "prepare") { controller.abort(); return Response.json(ticket); }
      return reply;
    }, "/preview", identity, tool, controller.signal)).rejects.toBeInstanceOf(BrowserCancellationUnconfirmed);
  }
});

test("denies malformed tickets and failed preparation or invocation", async () => {
  await expect(invokeBrowserTool(async () => new Response("denied", { status: 403 }), "/preview", identity, tool, new AbortController().signal)).rejects.toThrow("access changed");
  await expect(invokeBrowserTool(async () => new Response("failed", { status: 500 }), "/preview", identity, tool, new AbortController().signal)).rejects.toThrow("prepared");
  await expect(invokeBrowserTool(async () => Response.json({ requestId: "forged" }), "/preview", identity, tool, new AbortController().signal)).rejects.toThrow("ticket");
  await expect(invokeBrowserTool(async (_url, init) => JSON.parse(String(init.body)).method === "prepare" ? Response.json(ticket) : new Response("denied", { status: 403 }), "/preview", identity, tool, new AbortController().signal)).rejects.toThrow("access changed");
  await expect(invokeBrowserTool(async (_url, init) => JSON.parse(String(init.body)).method === "prepare" ? Response.json(ticket) : new Response("failed", { status: 500 }), "/preview", identity, tool, new AbortController().signal)).rejects.toThrow("failed");
});
