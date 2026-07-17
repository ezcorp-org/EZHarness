import { test, expect, describe } from "bun:test";
import { RateLimiter } from "../../lib/server/security/rate-limiter";
import { getMaxPayload } from "../../lib/server/security/payload";

// Replicate the rate limit route matching logic from hooks.server.ts
// to test path patterns without importing the full hooks module (which has side effects)
interface RateLimitRoute {
  pattern: RegExp;
  method?: string;
  limit: number;
  keyType: "ip" | "user";
  category: string;
}

const RATE_LIMITED_ROUTES: RateLimitRoute[] = [
  { pattern: /^\/api\/auth\/login$/, limit: 5, keyType: "ip", category: "login" },
  { pattern: /^\/api\/conversations\/[^/]+\/messages$/, method: "POST", limit: 20, keyType: "user", category: "chat" },
  { pattern: /^\/api\/agents\/[^/]+\/run$/, method: "POST", limit: 10, keyType: "user", category: "agentRun" },
  { pattern: /^\/api\/agent-configs\/generate$/, method: "POST", limit: 5, keyType: "user", category: "agentGenerate" },
  { pattern: /^\/api\/workflows\/[^/]+\/run$/, method: "POST", limit: 10, keyType: "user", category: "workflowRun" },
];

function matchRateLimitRoute(pathname: string, method: string): RateLimitRoute | undefined {
  for (const route of RATE_LIMITED_ROUTES) {
    if (route.method && route.method !== method) continue;
    if (route.pattern.test(pathname)) return route;
  }
  return undefined;
}

describe("hooks middleware - rate limit route matching", () => {
  test("matches /api/auth/login for any method", () => {
    const match = matchRateLimitRoute("/api/auth/login", "POST");
    expect(match).toBeDefined();
    expect(match!.category).toBe("login");
    expect(match!.keyType).toBe("ip");
    expect(match!.limit).toBe(5);
  });

  test("matches login for GET too (any method)", () => {
    const match = matchRateLimitRoute("/api/auth/login", "GET");
    expect(match).toBeDefined();
    expect(match!.category).toBe("login");
  });

  test("matches /api/conversations/:id/messages POST", () => {
    const match = matchRateLimitRoute("/api/conversations/abc-123/messages", "POST");
    expect(match).toBeDefined();
    expect(match!.category).toBe("chat");
    expect(match!.limit).toBe(20);
  });

  test("does not match /api/conversations/:id/messages GET", () => {
    const match = matchRateLimitRoute("/api/conversations/abc-123/messages", "GET");
    expect(match).toBeUndefined();
  });

  test("matches /api/agents/:id/run POST", () => {
    const match = matchRateLimitRoute("/api/agents/some-agent/run", "POST");
    expect(match).toBeDefined();
    expect(match!.category).toBe("agentRun");
    expect(match!.limit).toBe(10);
  });

  test("matches /api/agent-configs/generate POST", () => {
    const match = matchRateLimitRoute("/api/agent-configs/generate", "POST");
    expect(match).toBeDefined();
    expect(match!.category).toBe("agentGenerate");
    expect(match!.limit).toBe(5);
  });

  test("matches /api/workflows/:id/run POST", () => {
    const match = matchRateLimitRoute("/api/workflows/wf-1/run", "POST");
    expect(match).toBeDefined();
    expect(match!.category).toBe("workflowRun");
    expect(match!.limit).toBe(10);
  });

  test("does not match non-rate-limited routes", () => {
    expect(matchRateLimitRoute("/api/conversations", "GET")).toBeUndefined();
    expect(matchRateLimitRoute("/api/settings/foo", "PUT")).toBeUndefined();
    expect(matchRateLimitRoute("/api/users", "GET")).toBeUndefined();
    expect(matchRateLimitRoute("/api/agents/some-agent", "GET")).toBeUndefined();
  });

  test("does not match subpaths of rate-limited routes", () => {
    expect(matchRateLimitRoute("/api/auth/login/extra", "POST")).toBeUndefined();
    expect(matchRateLimitRoute("/api/conversations/abc/messages/extra", "POST")).toBeUndefined();
  });
});

describe("hooks middleware - rate limiter integration", () => {
  test("rate limiter enforces per-key limits", () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("ip:1.2.3.4:login", 5).allowed).toBe(true);
    }
    const result = limiter.check("ip:1.2.3.4:login", 5);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("different keys have independent limits", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.check("user:u1:chat", 2);
    limiter.check("user:u1:chat", 2);
    expect(limiter.check("user:u1:chat", 2).allowed).toBe(false);
    expect(limiter.check("user:u2:chat", 2).allowed).toBe(true);
  });

  test("different categories have independent limits", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.check("user:u1:chat", 2);
    limiter.check("user:u1:chat", 2);
    expect(limiter.check("user:u1:chat", 2).allowed).toBe(false);
    expect(limiter.check("user:u1:agentRun", 2).allowed).toBe(true);
  });
});

describe("hooks middleware - payload size check", () => {
  test("returns default 1MB for normal routes", () => {
    expect(getMaxPayload("/api/agents/run")).toBe(1024 * 1024);
    expect(getMaxPayload("/api/account")).toBe(1024 * 1024);
  });

  test("returns 50MB for knowledge-base routes", () => {
    expect(getMaxPayload("/api/knowledge-base")).toBe(50 * 1024 * 1024);
    expect(getMaxPayload("/api/knowledge-base/upload")).toBe(50 * 1024 * 1024);
  });

  test("returns 100MB for conversation routes (multi-modal chat attachments)", () => {
    expect(getMaxPayload("/api/conversations")).toBe(100 * 1024 * 1024);
    expect(getMaxPayload("/api/conversations/abc/messages")).toBe(100 * 1024 * 1024);
  });
});
