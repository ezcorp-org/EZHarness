// Regression test for sec-H1: POST /api/providers/local/test and
// POST /api/providers/local/models must be gated on requireRole(admin)
// and reject baseUrl values pointing at loopback/private/link-local
// addresses. Pre-fix the handlers were:
//   1. only gated by `requireScope(locals, "admin")` — a no-op for cookie
//      auth, so any authenticated member could drive the request; and
//   2. handed the user-supplied baseUrl straight to fetch() after only
//      a http(s):// scheme check.
//
// Exploit narrative:
//   1. A normal member POSTs { baseUrl: "http://169.254.169.254/latest/meta-data/",
//      modelId: "x" } to /api/providers/local/test. The server fetches
//      the cloud metadata service; testInference returns the upstream
//      response text as part of the JSON body → full exfiltration.
//   2. Same trick against http://127.0.0.1:6379/ (local Redis),
//      http://10.0.0.5:8080/ (internal k8s), etc.
//
// Fix (f1af9df):
//   - requireRole(locals, "admin") on both routes
//   - new isPrivateOrLoopback() helper rejects 127/8, 10/8, 172.16/12,
//     192.168/16, 169.254/16, 0/8, ::1, fc00::/7, fe80::/10, and
//     literal "localhost"
//   - both routes parse baseUrl via new URL() and return 400 on invalid URL
//
// Strategy: handler-level probe. Mock checkLocalModel/listModels to
// capture calls (they MUST NOT be reached for blocked baseUrls). Drive
// POST with: member role, admin with each SSRF target, admin with a
// non-loopback hostname (happy path), admin with garbage URL, etc. Also
// direct unit tests on isPrivateOrLoopback() for edge cases.
//
// Tests fix(sec-H1): f1af9df

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

// SvelteKit generated $types stubs — not present at test time.
mock.module("../../../web/src/routes/api/providers/local/test/$types", () => ({}));
mock.module("../../../web/src/routes/api/providers/local/models/$types", () => ({}));

// ── DNS lookup mock (for the sec-H1 DNS-pinning follow-up) ───────
// The production code calls node:dns/promises' `lookup(host, {all:true})`
// after the synchronous literal-IP check, so we have to intercept it at
// the module level or real NXDOMAINs will break the existing happy-path
// tests (which use `.invalid` and `.example.com` hostnames).
type LookupResult = Array<{ address: string; family: 4 | 6 }>;
// Default: public-IP resolutions for the existing happy-path hostnames.
// Individual tests can override by setting entries on this map.
const dnsTable = new Map<string, LookupResult | Error>([
  ["mock-llm.example.invalid", [{ address: "203.0.113.10", family: 4 }]],
  ["api.example.com", [{ address: "203.0.113.20", family: 4 }]],
]);

// IP-literal detector for the mock — `dns.lookup` normally returns IP
// literals unchanged without hitting any resolver, so mirror that.
function looksLikeIPv4(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

mock.module("node:dns/promises", () => ({
  lookup: async (
    hostname: string,
    _options?: unknown,
  ): Promise<LookupResult> => {
    if (looksLikeIPv4(hostname)) {
      return [{ address: hostname, family: 4 }];
    }
    const hit = dnsTable.get(hostname);
    if (hit === undefined) {
      const err = new Error(`ENOTFOUND ${hostname}`) as Error & { code: string };
      err.code = "ENOTFOUND";
      throw err;
    }
    if (hit instanceof Error) throw hit;
    return hit;
  },
}));

// requireScope must stay a no-op passthrough — we're exercising the NEW
// requireRole gate, not an api-key scope check.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("../../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Capture upstream fetch calls ─────────────────────────────────
let checkCalls: Array<{ baseUrl: string; modelId: string }> = [];
let listCalls: Array<{ baseUrl: string }> = [];

const localCheckMock = () => ({
  checkLocalModel: async (baseUrl: string, modelId: string) => {
    checkCalls.push({ baseUrl, modelId });
    return {
      reachable: true,
      modelAvailable: true,
      inferenceOk: true,
      endpointType: "openai-compatible" as const,
      latencyMs: 10,
    };
  },
  listModels: async (baseUrl: string) => {
    listCalls.push({ baseUrl });
    return {
      models: [{ id: "llama3:latest", name: "llama3:latest" }],
      endpointType: "ollama" as const,
    };
  },
});
mock.module("$server/providers/local-model-check", localCheckMock);
mock.module("../../providers/local-model-check", localCheckMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────
import { POST as POST_TEST } from "../../../web/src/routes/api/providers/local/test/+server";
import { POST as POST_MODELS } from "../../../web/src/routes/api/providers/local/models/+server";
import { isPrivateOrLoopback } from "../../../web/src/lib/server/security/url-validation";

// SvelteKit handlers may throw a Response on auth failure; unwrap.
async function call(
  handler: (ev: any) => unknown,
  event: any,
): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  checkCalls = [];
  listCalls = [];
});

// Both routes share the same gating + SSRF validation, so parameterize
// the assertions over the (name, handler, okCalls, okResponseShape) tuples.
type Probe = {
  name: string;
  handler: (ev: any) => unknown;
  url: string;
  getCalls: () => Array<{ baseUrl: string }>;
  bodyFor: (baseUrl: string) => Record<string, unknown>;
};

const probes: Probe[] = [
  {
    name: "POST /api/providers/local/test",
    handler: POST_TEST,
    url: "http://localhost/api/providers/local/test",
    getCalls: () => checkCalls,
    bodyFor: (baseUrl) => ({ baseUrl, modelId: "llama3" }),
  },
  {
    name: "POST /api/providers/local/models",
    handler: POST_MODELS,
    url: "http://localhost/api/providers/local/models",
    getCalls: () => listCalls,
    bodyFor: (baseUrl) => ({ baseUrl }),
  },
];

for (const probe of probes) {
  describe(`sec-H1: ${probe.name} role gate`, () => {
    test("member role → 403, upstream fetch NOT reached", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("http://169.254.169.254/latest/meta-data/"),
        user: MEMBER_USER,
      });
      const res = await call(probe.handler, event);
      expect(res.status).toBe(403);
      // Pre-fix, the member would have been allowed straight through
      // and the metadata endpoint would have been fetched.
      expect(probe.getCalls().length).toBe(0);
    });

    test("unauthenticated → 401, upstream fetch NOT reached", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("http://169.254.169.254/latest/meta-data/"),
        // no user
      });
      const res = await call(probe.handler, event);
      expect(res.status).toBe(401);
      expect(probe.getCalls().length).toBe(0);
    });
  });

  describe(`sec-H1: ${probe.name} SSRF target validation`, () => {
    const ssrfTargets: Array<[string, string]> = [
      ["cloud metadata (169.254.169.254)", "http://169.254.169.254/latest/meta-data/"],
      ["loopback IPv4 (127.0.0.1)", "http://127.0.0.1:11434"],
      ["literal localhost", "http://localhost:11434"],
      ["private 10/8", "http://10.0.0.5:8080"],
      ["private 172.16/12 low edge", "http://172.16.0.1:8080"],
      ["private 172.16/12 high edge", "http://172.31.255.254:8080"],
      ["private 192.168/16", "http://192.168.1.1:8080"],
      ["loopback IPv6 ::1", "http://[::1]:11434"],
      ["link-local IPv6 fe80", "http://[fe80::1]:11434"],
      ["ULA IPv6 fc00", "http://[fc00::1]:11434"],
      ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]:11434"],
      ["0.0.0.0 wildcard", "http://0.0.0.0:11434"],
    ];

    for (const [label, baseUrl] of ssrfTargets) {
      test(`admin + ${label} → 400, upstream fetch NOT reached`, async () => {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor(baseUrl),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        const data = await jsonFromResponse(res);
        expect(res.status).toBe(400);
        expect(String(data.error)).toContain("private or loopback");
        // Pre-fix, the upstream fetch would have been reached for all of these.
        expect(probe.getCalls().length).toBe(0);
      });
    }

    test("admin + non-loopback hostname → happy path reaches upstream", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("http://mock-llm.example.invalid:11434"),
        user: ADMIN_USER,
      });
      const res = await call(probe.handler, event);
      expect(res.status).toBe(200);
      // Validation let this through → upstream was called.
      expect(probe.getCalls().length).toBe(1);
      expect(probe.getCalls()[0]!.baseUrl).toBe("http://mock-llm.example.invalid:11434");
    });

    test("admin + unparseable URL → 400 Invalid baseUrl, upstream NOT reached", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("ht!tp:not a url at all"),
        user: ADMIN_USER,
      });
      const res = await call(probe.handler, event);
      const data = await jsonFromResponse(res);
      expect(res.status).toBe(400);
      // Either "Invalid baseUrl" (URL parser threw) or the earlier
      // scheme-check "must start with http://". Both are acceptable —
      // the core guarantee is: upstream was NOT reached.
      expect(String(data.error)).toMatch(/Invalid baseUrl|http/);
      expect(probe.getCalls().length).toBe(0);
    });

    test("admin + https:// non-loopback hostname also works", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("https://api.example.com/v1"),
        user: ADMIN_USER,
      });
      const res = await call(probe.handler, event);
      expect(res.status).toBe(200);
      expect(probe.getCalls().length).toBe(1);
    });
  });

  describe(`sec-H1 (DNS-pinning follow-up): ${probe.name}`, () => {
    // The attacker controls DNS for `rebind.evil.test` and points it at
    // 127.0.0.1. Pre-follow-up this slipped past the sync check because
    // the literal hostname isn't private — only its resolved address is.
    test("admin + hostname resolving to 127.0.0.1 → 400, upstream NOT reached", async () => {
      dnsTable.set("rebind.evil.test", [{ address: "127.0.0.1", family: 4 }]);
      try {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor("http://rebind.evil.test:11434"),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        const data = await jsonFromResponse(res);
        expect(res.status).toBe(400);
        expect(String(data.error)).toContain("private/loopback");
        expect(probe.getCalls().length).toBe(0);
      } finally {
        dnsTable.delete("rebind.evil.test");
      }
    });

    test("admin + hostname resolving to IPv6 ::1 → 400, upstream NOT reached", async () => {
      dnsTable.set("rebind6.evil.test", [{ address: "::1", family: 6 }]);
      try {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor("http://rebind6.evil.test:11434"),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        const data = await jsonFromResponse(res);
        expect(res.status).toBe(400);
        expect(String(data.error)).toContain("private/loopback");
        expect(probe.getCalls().length).toBe(0);
      } finally {
        dnsTable.delete("rebind6.evil.test");
      }
    });

    test("admin + hostname resolving to mixed public+private → 400 (any private blocks)", async () => {
      dnsTable.set("mixed.evil.test", [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]);
      try {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor("http://mixed.evil.test:11434"),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        expect(res.status).toBe(400);
        expect(probe.getCalls().length).toBe(0);
      } finally {
        dnsTable.delete("mixed.evil.test");
      }
    });

    test("admin + nonexistent hostname (ENOTFOUND) → 400, upstream NOT reached", async () => {
      // Any hostname not in dnsTable throws ENOTFOUND from the mock, so
      // simply use a fresh name and assert the route translates the
      // thrown error into a 400.
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("http://does-not-resolve.nxdomain.test:11434"),
        user: ADMIN_USER,
      });
      const res = await call(probe.handler, event);
      const data = await jsonFromResponse(res);
      expect(res.status).toBe(400);
      expect(String(data.error)).toContain("could not be resolved");
      expect(probe.getCalls().length).toBe(0);
    });

    test("admin + hostname resolving to public 8.8.8.8 → 200 (happy path)", async () => {
      dnsTable.set("public.example.test", [{ address: "8.8.8.8", family: 4 }]);
      try {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor("http://public.example.test:11434"),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        expect(res.status).toBe(200);
        expect(probe.getCalls().length).toBe(1);
      } finally {
        dnsTable.delete("public.example.test");
      }
    });
  });
}

// ── Direct unit tests on isPrivateOrLoopback() ───────────────────
describe("sec-H1: isPrivateOrLoopback() unit tests", () => {
  test("empty hostname → blocked", () => {
    expect(isPrivateOrLoopback("")).toBe(true);
  });

  test("literal localhost (any case) → blocked", () => {
    expect(isPrivateOrLoopback("localhost")).toBe(true);
    expect(isPrivateOrLoopback("LOCALHOST")).toBe(true);
    expect(isPrivateOrLoopback("LocalHost")).toBe(true);
  });

  test("127.0.0.0/8 → blocked", () => {
    expect(isPrivateOrLoopback("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("127.1.2.3")).toBe(true);
    expect(isPrivateOrLoopback("127.255.255.255")).toBe(true);
  });

  test("10.0.0.0/8 → blocked", () => {
    expect(isPrivateOrLoopback("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("10.255.255.255")).toBe(true);
  });

  test("172.16.0.0/12 → blocked on every octet in range", () => {
    expect(isPrivateOrLoopback("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopback("172.20.0.1")).toBe(true);
    expect(isPrivateOrLoopback("172.31.255.254")).toBe(true);
  });

  test("172.16/12 neighbors are NOT blocked", () => {
    expect(isPrivateOrLoopback("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopback("172.32.0.1")).toBe(false);
  });

  test("192.168.0.0/16 → blocked", () => {
    expect(isPrivateOrLoopback("192.168.0.1")).toBe(true);
    expect(isPrivateOrLoopback("192.168.255.255")).toBe(true);
  });

  test("192.167/192.169 NOT blocked", () => {
    expect(isPrivateOrLoopback("192.167.1.1")).toBe(false);
    expect(isPrivateOrLoopback("192.169.1.1")).toBe(false);
  });

  test("169.254.0.0/16 link-local (cloud metadata) → blocked", () => {
    expect(isPrivateOrLoopback("169.254.169.254")).toBe(true);
    expect(isPrivateOrLoopback("169.254.0.1")).toBe(true);
  });

  test("169.253/169.255 NOT blocked", () => {
    expect(isPrivateOrLoopback("169.253.1.1")).toBe(false);
    expect(isPrivateOrLoopback("169.255.1.1")).toBe(false);
  });

  test("0.0.0.0/8 → blocked", () => {
    expect(isPrivateOrLoopback("0.0.0.0")).toBe(true);
    expect(isPrivateOrLoopback("0.1.2.3")).toBe(true);
  });

  test("public IPv4 → NOT blocked", () => {
    expect(isPrivateOrLoopback("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopback("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopback("172.15.255.255")).toBe(false);
    expect(isPrivateOrLoopback("11.0.0.1")).toBe(false);
  });

  test("IPv6 ::1 and :: → blocked", () => {
    expect(isPrivateOrLoopback("::1")).toBe(true);
    expect(isPrivateOrLoopback("::")).toBe(true);
  });

  test("IPv6 literals wrapped in [] → brackets stripped and blocked", () => {
    expect(isPrivateOrLoopback("[::1]")).toBe(true);
    expect(isPrivateOrLoopback("[fe80::1]")).toBe(true);
    expect(isPrivateOrLoopback("[fc00::1]")).toBe(true);
  });

  test("IPv6 fe80::/10 link-local → blocked", () => {
    expect(isPrivateOrLoopback("fe80::1")).toBe(true);
    expect(isPrivateOrLoopback("feb0::1")).toBe(true);
  });

  test("IPv6 fc00::/7 ULA → blocked", () => {
    expect(isPrivateOrLoopback("fc00::1")).toBe(true);
    expect(isPrivateOrLoopback("fd12:3456::1")).toBe(true);
  });

  test("IPv4-mapped IPv6 loopback → blocked", () => {
    expect(isPrivateOrLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:10.0.0.1")).toBe(true);
  });

  test("IPv4-mapped IPv6 public → NOT blocked", () => {
    expect(isPrivateOrLoopback("::ffff:8.8.8.8")).toBe(false);
  });

  test("public IPv6 → NOT blocked", () => {
    expect(isPrivateOrLoopback("2001:4860:4860::8888")).toBe(false);
  });

  test("non-IP hostnames are NOT blocked (DNS pinning is follow-up work)", () => {
    // The fix deliberately does not resolve DNS — see commit message.
    expect(isPrivateOrLoopback("api.example.com")).toBe(false);
    expect(isPrivateOrLoopback("mock-llm.example.invalid")).toBe(false);
  });
});
