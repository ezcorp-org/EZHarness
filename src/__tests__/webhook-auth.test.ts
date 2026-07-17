/**
 * Coverage for the pure webhook auth logic (Loops EZ Mode Phase 4):
 * constant-time compare, bearer parsing, and dual-scheme verification
 * (Bearer + X-Hub-Signature-256 HMAC), incl. the cross-hook replay guard.
 */
import { test, expect, describe } from "bun:test";
import { createHmac } from "node:crypto";
import {
  constantTimeEqual,
  parseBearer,
  verifyWebhookAuth,
  webhookSignature,
} from "../extensions/webhook-auth";

const SECRET = "ezhook_supersecrettoken";
const OTHER_SECRET = "ezhook_a-different-hooks-token";

describe("constantTimeEqual", () => {
  test("equal strings → true; different → false; length-independent", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    // Different lengths do not throw (digests are equal-length).
    expect(constantTimeEqual("a", "abcdefghijklmnop")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("parseBearer", () => {
  test("extracts the token from a Bearer header (case-insensitive scheme)", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
    expect(parseBearer("BEARER   spaced-token  ")).toBe("spaced-token");
  });

  test("null / non-Bearer / empty → null", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("")).toBeNull();
  });
});

describe("verifyWebhookAuth — bearer", () => {
  test("valid bearer → ok:bearer", () => {
    expect(verifyWebhookAuth(SECRET, { bearer: SECRET }, "")).toEqual({ ok: true, method: "bearer" });
  });

  test("wrong bearer → not ok", () => {
    expect(verifyWebhookAuth(SECRET, { bearer: "nope" }, "").ok).toBe(false);
  });

  test("cross-hook replay: hook A's token against hook B's secret → rejected", () => {
    // The route verifies against the TARGET hook's secret, so a token minted
    // for another hook never authenticates this one.
    expect(verifyWebhookAuth(OTHER_SECRET, { bearer: SECRET }, "").ok).toBe(false);
  });
});

describe("verifyWebhookAuth — HMAC (X-Hub-Signature-256)", () => {
  test("valid signature over the raw body → ok:hmac", () => {
    const body = '{"ticket":42}';
    const sig = webhookSignature(SECRET, body);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookAuth(SECRET, { signature: sig }, body)).toEqual({ ok: true, method: "hmac" });
  });

  test("signature over a DIFFERENT body → rejected (tamper detection)", () => {
    const sig = webhookSignature(SECRET, '{"ticket":42}');
    expect(verifyWebhookAuth(SECRET, { signature: sig }, '{"ticket":43}').ok).toBe(false);
  });

  test("signature with the wrong secret → rejected", () => {
    const body = "payload";
    const sig = "sha256=" + createHmac("sha256", OTHER_SECRET).update(body).digest("hex");
    expect(verifyWebhookAuth(SECRET, { signature: sig }, body).ok).toBe(false);
  });
});

describe("verifyWebhookAuth — absent / mixed", () => {
  test("both headers absent → not ok", () => {
    expect(verifyWebhookAuth(SECRET, {}, "").ok).toBe(false);
    expect(verifyWebhookAuth(SECRET, { bearer: null, signature: null }, "").ok).toBe(false);
    expect(verifyWebhookAuth(SECRET, { bearer: "", signature: "" }, "").ok).toBe(false);
  });

  test("an invalid bearer does not veto a valid HMAC in the same request", () => {
    const body = "b";
    const sig = webhookSignature(SECRET, body);
    expect(verifyWebhookAuth(SECRET, { bearer: "wrong", signature: sig }, body)).toEqual({
      ok: true,
      method: "hmac",
    });
  });
});
