import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  test("unregistered provider is unbounded", () => {
    const rl = new RateLimiter({ windowMs: 1000, now: () => 0 });
    for (let i = 0; i < 1000; i++) expect(rl.allow("unknown")).toBe(true);
  });

  test("Infinity limit is unbounded", () => {
    const rl = new RateLimiter({ windowMs: 1000, now: () => 0 });
    rl.register("tavily", Infinity);
    for (let i = 0; i < 1000; i++) expect(rl.allow("tavily")).toBe(true);
  });

  test("allows up to N hits then denies the N+1st within the window", () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, now: () => t });
    rl.register("jina", 3);
    expect(rl.allow("jina")).toBe(true);
    expect(rl.allow("jina")).toBe(true);
    expect(rl.allow("jina")).toBe(true);
    expect(rl.allow("jina")).toBe(false);
  });

  test("window slide restores capacity", () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, now: () => t });
    rl.register("jina", 2);
    expect(rl.allow("jina")).toBe(true); // t=0
    expect(rl.allow("jina")).toBe(true); // t=0
    expect(rl.allow("jina")).toBe(false);
    t = 1500;
    expect(rl.allow("jina")).toBe(true); // old hits expired
  });

  test("providers are tracked independently", () => {
    const rl = new RateLimiter({ windowMs: 1000, now: () => 0 });
    rl.register("jina", 1);
    rl.register("brave", 1);
    expect(rl.allow("jina")).toBe(true);
    expect(rl.allow("jina")).toBe(false);
    expect(rl.allow("brave")).toBe(true);
    expect(rl.allow("brave")).toBe(false);
  });

  test("re-registering updates the limit", () => {
    const rl = new RateLimiter({ windowMs: 1000, now: () => 0 });
    rl.register("jina", 1);
    expect(rl.allow("jina")).toBe(true);
    expect(rl.allow("jina")).toBe(false);
    rl.register("jina", 5);
    for (let i = 0; i < 4; i++) expect(rl.allow("jina")).toBe(true);
    expect(rl.allow("jina")).toBe(false);
  });

  test("default clock uses Date.now when none is injected", () => {
    const rl = new RateLimiter({ windowMs: 10 });
    rl.register("j", 1);
    expect(rl.allow("j")).toBe(true);
    expect(rl.allow("j")).toBe(false);
  });
});
