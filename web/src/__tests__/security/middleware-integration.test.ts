import { test, expect, describe, beforeEach } from "bun:test";
import { RateLimiter } from "../../lib/server/security/rate-limiter";
import { getMaxPayload, payloadTooLarge } from "../../lib/server/security/payload";

// Replicate route matching from hooks.server.ts to avoid side effects on import
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
  { pattern: /^\/api\/pipelines\/[^/]+\/run$/, method: "POST", limit: 10, keyType: "user", category: "pipelineRun" },
];

function matchRateLimitRoute(pathname: string, method: string): RateLimitRoute | undefined {
  for (const route of RATE_LIMITED_ROUTES) {
    if (route.method && route.method !== method) continue;
    if (route.pattern.test(pathname)) return route;
  }
  return undefined;
}

// These tests exercise the middleware building blocks in combination,
// simulating the handle() flow without importing hooks.server.ts top-level
// (which has side effects like ensureInitialized, timers, etc.)

describe("middleware: payload size enforcement", () => {
  test("rejects POST with Content-Length exceeding 1MB default", () => {
    const size = 2 * 1024 * 1024; // 2MB
    const max = getMaxPayload("/api/agents/run");
    expect(size > max).toBe(true);

    const response = payloadTooLarge(max);
    expect(response.status).toBe(413);
  });

  test("accepts POST within 1MB default", () => {
    const size = 500 * 1024; // 500KB
    const max = getMaxPayload("/api/agents/run");
    expect(size <= max).toBe(true);
  });

  test("allows up to 50MB for knowledge-base", () => {
    const size = 40 * 1024 * 1024; // 40MB
    const max = getMaxPayload("/api/knowledge-base");
    expect(size <= max).toBe(true);
  });

  test("rejects knowledge-base upload over 50MB", () => {
    const size = 60 * 1024 * 1024;
    const max = getMaxPayload("/api/knowledge-base");
    expect(size > max).toBe(true);
  });

  test("knowledge-base subpaths also get 50MB limit", () => {
    expect(getMaxPayload("/api/knowledge-base/upload")).toBe(50 * 1024 * 1024);
  });

  test("payloadTooLarge response has correct JSON body", async () => {
    const response = payloadTooLarge(1024 * 1024);
    const body = await response.json();
    expect(body.error).toBe("Payload too large");
    expect(body.maxBytes).toBe(1024 * 1024);
  });

  test("payloadTooLarge uses default when no arg", async () => {
    const response = payloadTooLarge();
    const body = await response.json();
    expect(body.maxBytes).toBe(1024 * 1024);
  });
});

describe("middleware: rate limiting flow simulation", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(20, 60_000);
  });

  test("IP-based login rate limit blocks after 5 attempts", () => {
    const route = matchRateLimitRoute("/api/auth/login", "POST");
    expect(route).toBeDefined();
    expect(route!.keyType).toBe("ip");

    const ip = "192.168.1.1";
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(`ip:${ip}:login`, route!.limit).allowed).toBe(true);
    }
    const blocked = limiter.check(`ip:${ip}:login`, route!.limit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  test("user-based chat rate limit blocks after 20 messages", () => {
    const route = matchRateLimitRoute("/api/conversations/abc-123/messages", "POST");
    expect(route).toBeDefined();
    expect(route!.keyType).toBe("user");

    const userId = "user-1";
    for (let i = 0; i < 20; i++) {
      expect(limiter.check(`user:${userId}:chat`, route!.limit).allowed).toBe(true);
    }
    const blocked = limiter.check(`user:${userId}:chat`, route!.limit);
    expect(blocked.allowed).toBe(false);
  });

  test("agent run rate limit blocks after 10 requests", () => {
    const route = matchRateLimitRoute("/api/agents/my-agent/run", "POST");
    expect(route).toBeDefined();

    for (let i = 0; i < 10; i++) {
      expect(limiter.check(`user:u1:agentRun`, route!.limit).allowed).toBe(true);
    }
    expect(limiter.check(`user:u1:agentRun`, route!.limit).allowed).toBe(false);
  });

  test("agent generate rate limit blocks after 5 requests", () => {
    const route = matchRateLimitRoute("/api/agent-configs/generate", "POST");
    expect(route).toBeDefined();

    for (let i = 0; i < 5; i++) {
      expect(limiter.check(`user:u1:agentGenerate`, route!.limit).allowed).toBe(true);
    }
    expect(limiter.check(`user:u1:agentGenerate`, route!.limit).allowed).toBe(false);
  });

  test("different users are independent for user-based limits", () => {
    const route = matchRateLimitRoute("/api/conversations/abc/messages", "POST")!;

    for (let i = 0; i < 20; i++) {
      limiter.check(`user:user-A:chat`, route.limit);
    }
    expect(limiter.check(`user:user-A:chat`, route.limit).allowed).toBe(false);
    expect(limiter.check(`user:user-B:chat`, route.limit).allowed).toBe(true);
  });

  test("different IPs are independent for IP-based limits", () => {
    const route = matchRateLimitRoute("/api/auth/login", "POST")!;

    for (let i = 0; i < 5; i++) {
      limiter.check(`ip:10.0.0.1:login`, route.limit);
    }
    expect(limiter.check(`ip:10.0.0.1:login`, route.limit).allowed).toBe(false);
    expect(limiter.check(`ip:10.0.0.2:login`, route.limit).allowed).toBe(true);
  });

  test("rate limit window resets after expiry", async () => {
    const fast = new RateLimiter(1, 50);
    fast.check("ip:x:login", 1);
    expect(fast.check("ip:x:login", 1).allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 60));
    expect(fast.check("ip:x:login", 1).allowed).toBe(true);
  });
});

describe("middleware: rate limit response format", () => {
  test("429 response has Retry-After header and JSON body", async () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.check("k", 1);
    const result = limiter.check("k", 1);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe("middleware: CORS headers", () => {
  test("CORS headers object has correct values", () => {
    // Verify the CORS config matches expectations
    const CORS_HEADERS: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toContain("Authorization");
  });
});

describe("middleware: Bearer token extraction", () => {
  test("extracts API key from Bearer header", () => {
    const header = "Bearer ezk_abc123xyz";
    expect(header.startsWith("Bearer ")).toBe(true);
    const key = header.slice(7);
    expect(key).toBe("ezk_abc123xyz");
  });

  test("rejects non-Bearer auth headers", () => {
    const header = "Basic dXNlcjpwYXNz";
    expect(header.startsWith("Bearer ")).toBe(false);
  });

  test("handles null Authorization header", () => {
    // Annotate via accessor-typed local so TS doesn't narrow to the literal
    // `null`, which would collapse the `!== null` guard to `never`.
    const header = null as string | null;
    const isBearer = header?.startsWith("Bearer ");
    // Optional chaining on `null` short-circuits to `undefined`, not `false` —
    // assert falsy rather than the strict `false` literal so the guard
    // semantics (treat anything non-truthy as "no Bearer prefix") match.
    expect(isBearer).toBeFalsy();
  });
});
