/**
 * Secure-preview per-preview quota (Phase 3b). Request rate token-bucket +
 * rolling byte budget, per-preview-id isolation, injected clock.
 */
import { test, expect, describe } from "bun:test";
import { createPreviewQuota } from "../runtime/preview/preview-rate-limit";

describe("createPreviewQuota — request rate", () => {
  test("allows up to the per-second cap, then rejects", () => {
    const q = createPreviewQuota({ maxRequestsPerSecond: 3, now: () => 1000 });
    expect(q.allowRequest("p1")).toBe(true);
    expect(q.allowRequest("p1")).toBe(true);
    expect(q.allowRequest("p1")).toBe(true);
    expect(q.allowRequest("p1")).toBe(false); // over cap
  });

  test("rejects an empty preview id", () => {
    const q = createPreviewQuota();
    expect(q.allowRequest("")).toBe(false);
  });

  test("per-preview isolation — one preview's flood doesn't starve another", () => {
    const q = createPreviewQuota({ maxRequestsPerSecond: 1, now: () => 1000 });
    expect(q.allowRequest("p1")).toBe(true);
    expect(q.allowRequest("p1")).toBe(false); // p1 exhausted
    expect(q.allowRequest("p2")).toBe(true); // p2 independent
  });

  test("forget drops the REQUEST token-bucket too (no per-id leak on reap)", () => {
    // The request bucket lives in the underlying createRateLimiter map; forget
    // must reset it as well as the byte window, else a reaped preview leaks an
    // entry there. After forget the id starts with a fresh full bucket.
    const q = createPreviewQuota({ maxRequestsPerSecond: 1, now: () => 1000 });
    expect(q.allowRequest("p1")).toBe(true);
    expect(q.allowRequest("p1")).toBe(false); // exhausted
    q.forget("p1");
    expect(q.allowRequest("p1")).toBe(true); // bucket dropped → fresh
  });
});

describe("createPreviewQuota — byte budget", () => {
  test("allows under budget, rejects over", () => {
    const q = createPreviewQuota({ maxBytesPerWindow: 100, windowMs: 1000, now: () => 0 });
    expect(q.allowBytes("p1", 60)).toBe(true);
    expect(q.allowBytes("p1", 40)).toBe(true); // exactly at 100
    expect(q.allowBytes("p1", 1)).toBe(false); // over
  });

  test("rolls over after the window elapses", () => {
    let t = 0;
    const q = createPreviewQuota({ maxBytesPerWindow: 100, windowMs: 1000, now: () => t });
    expect(q.allowBytes("p1", 100)).toBe(true);
    expect(q.allowBytes("p1", 1)).toBe(false); // window full
    t = 1000; // window elapsed → fresh budget
    expect(q.allowBytes("p1", 100)).toBe(true);
  });

  test("per-preview byte isolation", () => {
    const q = createPreviewQuota({ maxBytesPerWindow: 50, windowMs: 1000, now: () => 0 });
    expect(q.allowBytes("p1", 50)).toBe(true);
    expect(q.allowBytes("p1", 1)).toBe(false);
    expect(q.allowBytes("p2", 50)).toBe(true);
  });

  test("rejects negative / non-finite byte counts + empty id", () => {
    const q = createPreviewQuota();
    expect(q.allowBytes("p1", -1)).toBe(false);
    expect(q.allowBytes("p1", Number.NaN)).toBe(false);
    expect(q.allowBytes("", 10)).toBe(false);
  });

  test("forget drops a preview's byte window", () => {
    const q = createPreviewQuota({ maxBytesPerWindow: 100, windowMs: 100000, now: () => 0 });
    expect(q.allowBytes("p1", 100)).toBe(true);
    expect(q.allowBytes("p1", 1)).toBe(false);
    q.forget("p1");
    expect(q.allowBytes("p1", 100)).toBe(true); // fresh after forget
  });
});
