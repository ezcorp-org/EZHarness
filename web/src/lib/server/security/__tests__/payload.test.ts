// Unit tests for $lib/server/security/payload.ts.
//
// Pins each prefix-keyed limit declared in PAYLOAD_LIMITS so a future
// edit can't silently regress the cap a route depends on (e.g. the
// `/api/extensions` 25 MB outer limit that lets the extension upload
// route's own structured 413 surface to callers instead of the
// hook-level generic one).

import { test, expect, describe } from "bun:test";
import {
  getMaxPayload,
  payloadTooLarge,
} from "../payload";

const ONE_MB = 1024 * 1024;

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
