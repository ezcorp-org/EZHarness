import { test, expect, describe, beforeEach } from "bun:test";
import {
  getClientCapabilities,
  capabilityAcceptsFile,
  describeRejection,
  __resetCapabilityCacheForTests,
  type ClientCapabilities,
} from "../chat/attachment-client";

const CAPS: ClientCapabilities = {
  provider: "anthropic",
  model: "claude-3-5-sonnet",
  kinds: ["text", "image", "pdf"],
  acceptedMimeTypes: ["image/png", "text/plain", "application/pdf"],
  maxBytesPerFile: 20 * 1024 * 1024,
  maxFilesPerMessage: 10,
};

function makeFile(name: string, type: string, size = 10): File {
  const bytes = new Uint8Array(size);
  return new File([bytes as BlobPart], name, { type });
}

function stubFetch(status: number, payload: unknown) {
  const state = { calls: 0 };
  const impl = (async (_url: any) => {
    state.calls += 1;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
  impl.state = state;
  return impl as ((url: any) => Promise<Response>) & { state: { calls: number } };
}

beforeEach(() => __resetCapabilityCacheForTests());

describe("capabilityAcceptsFile", () => {
  test("accepts whitelisted MIME", () => {
    expect(capabilityAcceptsFile(CAPS, makeFile("a.png", "image/png"))).toBe(true);
  });
  test("rejects unlisted MIME", () => {
    expect(capabilityAcceptsFile(CAPS, makeFile("a.mp3", "audio/mpeg"))).toBe(false);
  });
  test("strips charset suffix from file.type", () => {
    expect(capabilityAcceptsFile(CAPS, makeFile("a.txt", "text/plain;charset=utf-8"))).toBe(true);
  });
});

describe("describeRejection", () => {
  test("mentions the per-file size limit in MB when oversized", () => {
    const big = makeFile("big.png", "image/png", CAPS.maxBytesPerFile + 1);
    expect(describeRejection(CAPS, big)).toContain("20MB");
  });
  test("mentions the model when the MIME is unaccepted", () => {
    const msg = describeRejection(CAPS, makeFile("a.mp3", "audio/mpeg"));
    expect(msg).toContain("claude-3-5-sonnet");
    expect(msg).toContain("audio/mpeg");
  });
});

describe("getClientCapabilities", () => {
  test("fetches once and caches per (provider, model)", async () => {
    const fetchImpl = stubFetch(200, CAPS);
    const a = await getClientCapabilities("anthropic", "claude-3-5-sonnet", fetchImpl as any);
    const b = await getClientCapabilities("anthropic", "claude-3-5-sonnet", fetchImpl as any);
    expect(a).toEqual(CAPS);
    expect(b).toBe(a);
    expect(fetchImpl.state.calls).toBe(1);
  });

  test("different model → separate fetch", async () => {
    const fetchImpl = stubFetch(200, CAPS);
    await getClientCapabilities("anthropic", "a", fetchImpl as any);
    await getClientCapabilities("anthropic", "b", fetchImpl as any);
    expect(fetchImpl.state.calls).toBe(2);
  });

  test("on HTTP error the cache entry is evicted so retries work", async () => {
    let callIdx = 0;
    const fetchImpl = (async () => {
      callIdx += 1;
      if (callIdx === 1) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(CAPS), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;
    let caught: unknown;
    try { await getClientCapabilities("anthropic", "m", fetchImpl as any); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const hit = await getClientCapabilities("anthropic", "m", fetchImpl as any);
    expect(hit).toEqual(CAPS);
  });
});
