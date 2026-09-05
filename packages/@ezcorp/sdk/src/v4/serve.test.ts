import { describe, expect, test } from "bun:test";
import { ContractError, createSession, defineExtension, serve } from "./index";
import type { ExtensionContext, ExtensionHandler } from "./index";

const metadata = { schemaVersion: 4 as const, name: "echo", version: "1.0.0", description: "Echo", author: { name: "Test" }, permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "string" } }] };
const identity = (invocationId = "call") => ({ invocationId, workerId: "worker", releaseId: "release", principalId: "alice", scopeId: "scope", token: `token-${invocationId}`, deadline: Date.now() + 5000 });
const request = (id: string, context = identity(id), input: unknown = { text: "hello" }) => ({ jsonrpc: "2.0", id, method: "extension/invoke", params: { name: "echo", input, context } });
const definition = (handler: ExtensionHandler = input => (input as { text: string }).text) => defineExtension({ manifest: metadata, tools: { echo: handler } });

describe("v4 protocol", () => {
  test("host CAS conflicts preserve their stable public discriminator", async () => {
    let session: ReturnType<typeof createSession>;
    const frames: string[] = [];
    session = createSession(definition(async (_input, context) => context.call("ezcorp/storage", {})), async frame => {
      frames.push(frame);
      const message = JSON.parse(frame);
      if (message.method) await session.receive({ jsonrpc: "2.0", id: message.id, error: { code: -32009, message: "State changed; reload before retrying." } });
    });
    await session.receive(request("conflict"));
    expect(JSON.parse(frames.at(-1)!).error.data.code).toBe("STATE_CONFLICT");
    session.close();
  });
  test("discovery returns immutable data and typed invocation enforces both schemas", async () => {
    const frames: any[] = [];
    let invoked = 0;
    const extension = definition(input => { invoked++; return (input as { text: string }).text; });
    const session = createSession(extension, frame => { frames.push(JSON.parse(frame)); });
    await session.receive({ jsonrpc: "2.0", id: "discover", method: "extension/discover", params: {} });
    expect(frames[0].result).toEqual(metadata);
    expect(Object.isFrozen(extension.manifest.tools?.[0]?.inputSchema)).toBe(true);
    await session.receive(request("valid"));
    expect(frames[1].result).toBe("hello");
    await session.receive(request("invalid", identity("invalid"), { text: 123 }));
    expect(frames[2].error.data.code).toBe("SCHEMA_MISMATCH");
    expect(invoked).toBe(1);
    session.close();
    const wrongOutput = createSession(definition(() => ({ untyped: true })), frame => { frames.push(JSON.parse(frame)); });
    await wrongOutput.receive(request("wrong-output"));
    expect(frames.at(-1).error.data.code).toBe("SCHEMA_MISMATCH");
    wrongOutput.close();
  });

  test("host requests bind exact invocation and expire after completion", async () => {
    let escaped: ExtensionContext | undefined;
    let session: ReturnType<typeof createSession>;
    const frames: any[] = [];
    session = createSession(definition(async (_input, context) => { escaped = context; return context.call("ezcorp/storage-get", { key: "one" }); }), async frame => {
      const message = JSON.parse(frame);
      frames.push(message);
      if (message.method) await session.receive({ jsonrpc: "2.0", id: message.id, result: "stored" });
    });
    const context = identity();
    await session.receive(request("host", context));
    expect(frames[0].params).toEqual({ context, input: { key: "one" } });
    expect(frames[1].result).toBe("stored");
    await expect(escaped!.call("ezcorp/storage-get", {})).rejects.toThrow();
    await session.receive(request("bob", { ...identity("bob"), principalId: "bob" }));
    expect(frames.at(-1).error.data.code).toBe("CONTEXT_MISMATCH");
    session.close();
  });

  test("cancellation interrupts handlers and late side effects fail", async () => {
    const frames: any[] = [];
    let escaped: ExtensionContext | undefined;
    let release: (() => void) | undefined;
    const session = createSession(definition(async (_input, context) => { escaped = context; await new Promise<void>(resolve => { release = resolve; }); return "late"; }), frame => { frames.push(JSON.parse(frame)); });
    const invocation = session.receive(request("slow"));
    await session.receive({ jsonrpc: "2.0", method: "extension/cancel", params: { invocationId: "slow" } });
    await invocation;
    expect(frames[0].error.data.code).toBe("CANCELLED");
    await expect(escaped!.call("ezcorp/write", {})).rejects.toThrow();
    release!();
    session.close();
  });

  test("deadline, concurrency, malformed frames and secret errors fail closed", async () => {
    const frames: any[] = [];
    const session = createSession(definition(() => { throw new Error("SECRET-PASSWORD"); }), frame => { frames.push(JSON.parse(frame)); });
    await session.receive(request("error"));
    expect(JSON.stringify(frames)).not.toContain("SECRET-PASSWORD");
    await session.receive(request("expired", { ...identity("expired"), deadline: 1 }));
    expect(frames.at(-1).error.data.code).toBe("DEADLINE_EXCEEDED");
    await expect(session.receive({ jsonrpc: "2.0", method: "extension/invoke" })).rejects.toThrow();
    await expect(session.receive({ jsonrpc: "2.0", id: "forged", result: {} })).rejects.toThrow();
    session.close();
    let finish: (() => void) | undefined;
    const bounded = createSession(definition(async () => { await new Promise<void>(resolve => { finish = resolve; }); return "done"; }), frame => { frames.push(JSON.parse(frame)); }, { maxConcurrentInvocations: 1 });
    const first = bounded.receive(request("first"));
    await bounded.receive(request("second"));
    expect(frames.at(-1).error.data.code).toBe("BUSY");
    finish!();
    await first;
    bounded.close();
  });

  test("stream rejects oversized unterminated frames, malformed UTF8 and truncation", async () => {
    const extension = definition();
    async function* bytes(value: Uint8Array | string) { yield value; }
    await expect(serve(extension, { input: bytes("x".repeat(65)), write: () => {}, maxFrameBytes: 64 })).rejects.toBeInstanceOf(ContractError);
    await expect(serve(extension, { input: bytes(new Uint8Array([0xff, 10])), write: () => {} })).rejects.toThrow();
    await expect(serve(extension, { input: bytes('{"jsonrpc":'), write: () => {} })).rejects.toThrow("Truncated");
  });

  test("host errors, pending cancellation and output failures settle requests", async () => {
    const frames: any[] = [];
    let session: ReturnType<typeof createSession>;
    session = createSession(definition((_input, context) => context.call("ezcorp/storage", {})), async frame => {
      const message = JSON.parse(frame); frames.push(message);
      if (message.method) await session.receive({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Denied" } });
    });
    await session.receive(request("denied"));
    expect(frames.at(-1).error.data.code).toBe("HOST_ERROR");
    session.close();
    const pendingFrames: any[] = [];
    const pendingSession = createSession(definition((_input, context) => context.call("ezcorp/storage", {})), frame => { pendingFrames.push(JSON.parse(frame)); });
    const operation = pendingSession.receive(request("cancel-host"));
    await pendingSession.receive({ jsonrpc: "2.0", method: "extension/cancel", params: { invocationId: "cancel-host" } });
    await operation;
    expect(pendingFrames.at(-1).error.data.code).toBe("CANCELLED");
    pendingSession.close();
    const broken = createSession(definition((_input, context) => context.call("ezcorp/storage", {})), () => { throw new Error("Pipe closed"); });
    await expect(broken.receive(request("broken"))).rejects.toThrow("Pipe closed");
    broken.close();
  });

  test("real Bun process discovers and invokes through SDK stdin transport", async () => {
    const sdk = new URL("./index.ts", import.meta.url).pathname;
    const script = `import {defineExtension,serve} from ${JSON.stringify(sdk)}; await serve(defineExtension({manifest:${JSON.stringify(metadata)},tools:{echo:input=>input.text}}));`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const frames: any[] = [];
    let buffer = "";
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        let boundary: number;
        while ((boundary = buffer.indexOf("\n")) !== -1) { frames.push(JSON.parse(buffer.slice(0, boundary))); buffer = buffer.slice(boundary + 1); }
      }
    })();
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "discover", method: "extension/discover", params: {} })}\n`);
      child.stdin.write(`${JSON.stringify(request("process"))}\n`);
      child.stdin.flush();
      const deadline = Date.now() + 5000;
      while (frames.length < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(frames.find(frame => frame.id === "discover")?.result).toEqual(metadata);
      expect(frames.find(frame => frame.id === "process")?.result).toBe("hello");
      child.stdin.end();
      expect(await child.exited).toBe(0);
      await reading;
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
