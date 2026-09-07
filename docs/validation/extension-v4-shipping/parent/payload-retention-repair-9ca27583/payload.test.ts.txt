// Unit tests for $lib/server/security/payload.ts.
//
// Pins each prefix-keyed limit declared in PAYLOAD_LIMITS so a future
// edit can't silently regress the cap a route depends on (e.g. the
// `/api/extensions` 25 MB outer limit that lets the extension upload
// route's own structured 413 surface to callers instead of the
// hook-level generic one).

import { test, expect, describe } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import {
  admitRequestPayload,
  getMaxPayload,
  payloadTooLarge,
} from "../payload";
import { readBoundedJson } from "../bounded-json";

const ONE_MB = 1024 * 1024;
const RETAINED_REQUEST_LIMIT = 16;
const faultMode = process.env.EZ_PAYLOAD_RETENTION_FAULT;
if (faultMode !== undefined && faultMode !== "native") throw new Error("EZ_PAYLOAD_RETENTION_FAULT must be native when set");

async function retentionCounts(mode: "native" | "stream"): Promise<{ warm: number; first: number; second: number }> {
  const child = Bun.spawn([
    "timeout", "--foreground", "--kill-after=5s", "15s",
    process.execPath, join(import.meta.dir, "payload-retention-child.ts"),
  ], {
    env: { ...process.env, EZ_PAYLOAD_RETENTION_MODE: mode },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout) as { warm: number; first: number; second: number };
  } finally {
    child.kill();
    await child.exited;
  }
}

function hasBoundedRequests(counts: { warm: number; first: number; second: number }): boolean {
  return counts.first - counts.warm <= RETAINED_REQUEST_LIMIT
    && counts.second - counts.first <= RETAINED_REQUEST_LIMIT;
}

test("bodyless request admission preserves the original request", async () => {
  const request = new Request("http://localhost/api/extensions/control");
  expect(await admitRequestPayload(request, "/api/extensions/control")).toBe(request);
});

test("admitted Bun server payload remains readable through the request event context", async () => {
  type RequestEvent = { request: Request; platform: { request: Request } };
  const events = new AsyncLocalStorage<RequestEvent>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(rawRequest) {
      // Match the adapter: make the public request before its event enters ALS.
      const request = new Request(rawRequest.url, rawRequest);
      const event = { request, platform: { request: rawRequest } };
      return events.run(event, async () => {
        event.request = await admitRequestPayload(event.request, "/api/extensions/control");
        const payload = await readBoundedJson(event.request, getMaxPayload("/api/extensions/control")) as { text: string };
        return Response.json({ text: payload.text, preserved: events.getStore() === event });
      });
    },
  });
  const text = `payload-${"😀".repeat(1024)}`;
  try {
    const response = await fetch(new URL("/api/extensions/control", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text, preserved: true });
  } finally {
    server.stop(true);
  }
});

test("stream admission stays bounded across two Bun ALS request batches", async () => {
  const counts = await retentionCounts(faultMode === "native" ? "native" : "stream");
  expect(hasBoundedRequests(counts)).toBe(true);
}, 30_000);

describe("getMaxPayload — prefix table", () => {
  test("/api/extensions/<name>/uploads → 25MB", () => {
    expect(getMaxPayload("/api/extensions/kokoro-tts/uploads")).toBe(25 * ONE_MB);
  });

  test("any /api/extensions sub-path → 25MB (events branch)", () => {
    // Defensive: every nested route under /api/extensions inherits the
    // same outer limit, so the events branch and any future siblings
    // get the same generous-but-bounded ceiling.
    expect(getMaxPayload("/api/extensions/foo/events/bar")).toBe(25 * ONE_MB);
  });

  test("/api/conversations/<id>/messages → 100MB (regression guard)", () => {
    // Multi-modal chat attachments can push a single message body well
    // above the default 1MB cap; the per-file cap is enforced
    // downstream by the model-capability validator.
    expect(getMaxPayload("/api/conversations/x/messages")).toBe(100 * ONE_MB);
  });

  test("/api/knowledge-base/upload → 50MB (regression guard)", () => {
    expect(getMaxPayload("/api/knowledge-base/upload")).toBe(50 * ONE_MB);
  });

  test("unmatched path → 1MB default", () => {
    expect(getMaxPayload("/api/something-else")).toBe(ONE_MB);
  });
});

describe("payloadTooLarge — 413 response shape", () => {
  test("returns 413 with structured JSON body that echoes maxBytes", async () => {
    const res = payloadTooLarge(123);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({ error: "Payload too large", maxBytes: 123 });
  });

  test("no-arg call defaults maxBytes to 1MB", async () => {
    const res = payloadTooLarge();
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.maxBytes).toBe(ONE_MB);
    expect(body.error).toBe("Payload too large");
  });
});
