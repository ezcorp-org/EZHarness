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
  // Real contract: null when the principal IS an admin, else a 403 Response.
  // RETURNED, never thrown — a thrown Response 500s via SvelteKit.
  requireAdmin: (locals: { user?: { role?: string } }) =>
    locals.user?.role === "admin"
      ? null
      : Response.json({ error: "Admin role required" }, { status: 403 }),
}));
mock.module("../../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
  // Real contract: null when the principal IS an admin, else a 403 Response.
  // RETURNED, never thrown — a thrown Response 500s via SvelteKit.
  requireAdmin: (locals: { user?: { role?: string } }) =>
    locals.user?.role === "admin"
      ? null
      : Response.json({ error: "Admin role required" }, { status: 403 }),
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
import {
  isPrivateOrLoopback,
  isLoopbackLiteral,
  loopbackProvidersBlocked,
  BLOCK_LOOPBACK_ENV,
} from "../../../web/src/lib/server/security/url-validation";

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

    // 403, not 401: the gate is now the role-only `requireAdmin`, which
    // RETURNS its denial (requireRole THREW one, so the caller actually got a
    // 500) and treats "no principal" as "not an admin". Hook-unreachable
    // either way — hooks.server.ts 401s unauthenticated /api/* first. What
    // matters for sec-H1 is unchanged: the upstream fetch is never reached.
    test("unauthenticated → 403, upstream fetch NOT reached", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("http://169.254.169.254/latest/meta-data/"),
        // no user
      });
      const res = await call(probe.handler, event);
      expect(res.status).toBe(403);
      expect(probe.getCalls().length).toBe(0);
    });
  });

  describe(`sec-H1: ${probe.name} SSRF target validation`, () => {
    // NOTE (fix/local-inference-usable): the four LOOPBACK entries that used
    // to live in this list moved to the `loopbackTargets` describe below —
    // they are now ALLOWED by the deliberate, documented carve-out in
    // `checkLocalProviderTarget` (a local Ollama could otherwise not be
    // registered through the UI at all, because the UI auto-fills
    // `http://localhost:11434` and the server then refused its own
    // suggestion). Nothing was deleted: every one of them is still asserted,
    // as a 200 here and as a 400 again under the env kill-switch. Every
    // NON-loopback target below is untouched and still refused.
    const ssrfTargets: Array<[string, string]> = [
      ["cloud metadata (169.254.169.254)", "http://169.254.169.254/latest/meta-data/"],
      ["private 10/8", "http://10.0.0.5:8080"],
      ["private 172.16/12 low edge", "http://172.16.0.1:8080"],
      ["private 172.16/12 high edge", "http://172.31.255.254:8080"],
      ["private 192.168/16", "http://192.168.1.1:8080"],
      ["link-local IPv6 fe80", "http://[fe80::1]:11434"],
      ["ULA IPv6 fc00", "http://[fc00::1]:11434"],
      ["0.0.0.0 wildcard", "http://0.0.0.0:11434"],
      ["unspecified IPv6 ::", "http://[::]:11434"],
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

    test("admin + scheme-valid but unparseable URL → 400 Invalid baseUrl", async () => {
      // "https://" clears the startsWith scheme check but `new URL()` throws
      // on it, so this is the ONLY input that reaches the URL-parse catch —
      // the "ht!tp:…" case above is refused one check earlier.
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("https://"),
        user: ADMIN_USER,
      });
      const res = await call(probe.handler, event);
      const data = await jsonFromResponse(res);
      expect(res.status).toBe(400);
      expect(String(data.error)).toBe("Invalid baseUrl");
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

  // ── The loopback carve-out (fix/local-inference-usable) ─────────────
  //
  // Paired on purpose: every test here that proves "this now succeeds" has a
  // sibling above proving a NON-loopback private address still fails, and a
  // sibling below proving the same URL fails again under the kill-switch.
  describe(`loopback carve-out: ${probe.name} allows literal loopback`, () => {
    const loopbackTargets: Array<[string, string]> = [
      // THE case this whole carve-out exists for: the exact string the
      // settings UI auto-fills for a new Ollama provider
      // (web/src/lib/components/settings/CustomModelsSection.svelte:156).
      ["the UI's auto-filled Ollama URL", "http://localhost:11434"],
      ["loopback IPv4 (127.0.0.1)", "http://127.0.0.1:11434"],
      ["127/8 non-.1 host", "http://127.0.0.53:11434"],
      ["loopback IPv6 ::1", "http://[::1]:11434"],
      ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]:11434"],
      ["ip6-localhost alias", "http://ip6-localhost:11434"],
    ];

    for (const [label, baseUrl] of loopbackTargets) {
      test(`admin + ${label} → 200, upstream IS reached`, async () => {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor(baseUrl),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        expect(res.status).toBe(200);
        // Reaching upstream is the whole point — pre-carve-out this was a 400
        // and `getCalls()` was 0. Note the DNS mock has no entry for
        // "localhost"/"ip6-localhost" and throws ENOTFOUND for unknown names,
        // so a 200 here also proves the DNS pin is SKIPPED for literals
        // (there is nothing to rebind) rather than merely passing.
        expect(probe.getCalls().length).toBe(1);
        expect(probe.getCalls()[0]!.baseUrl).toBe(baseUrl);
      });
    }

    test("member role is STILL refused on a loopback URL (carve-out is not an auth bypass)", async () => {
      const event = createMockEvent({
        method: "POST",
        url: probe.url,
        body: probe.bodyFor("http://localhost:11434"),
        user: MEMBER_USER,
      });
      const res = await call(probe.handler, event);
      expect(res.status).toBe(403);
      expect(probe.getCalls().length).toBe(0);
    });

    test("a hostname that RESOLVES to 127.0.0.1 is still refused (rebinding defense intact)", async () => {
      // The carve-out keys on the LITERAL hostname. `loopback.evil.test` is
      // not a literal loopback form, so it takes the DNS-pinned path and is
      // blocked exactly as before — this is the case that would prove the
      // carve-out too wide if it ever passed.
      dnsTable.set("loopback.evil.test", [{ address: "127.0.0.1", family: 4 }]);
      try {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor("http://loopback.evil.test:11434"),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        const data = await jsonFromResponse(res);
        expect(res.status).toBe(400);
        expect(String(data.error)).toContain("private/loopback");
        expect(probe.getCalls().length).toBe(0);
      } finally {
        dnsTable.delete("loopback.evil.test");
      }
    });

    test("EZCORP_BLOCK_LOOPBACK_PROVIDERS=1 restores the pre-carve-out refusal", async () => {
      const saved = process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS;
      process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS = "1";
      try {
        const event = createMockEvent({
          method: "POST",
          url: probe.url,
          body: probe.bodyFor("http://localhost:11434"),
          user: ADMIN_USER,
        });
        const res = await call(probe.handler, event);
        const data = await jsonFromResponse(res);
        expect(res.status).toBe(400);
        expect(String(data.error)).toContain("private or loopback");
        expect(probe.getCalls().length).toBe(0);
      } finally {
        if (saved === undefined) delete process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS;
        else process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS = saved;
      }
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

// ── The carve-out predicate, in isolation ────────────────────────
//
// `isLoopbackLiteral` must be a STRICT SUBSET of `isPrivateOrLoopback`: every
// hostname it accepts must be one the general guard blocks (otherwise it is
// carving out something that was never restricted), and it must accept none
// of the private/link-local/ULA/unspecified space. Both directions asserted.
describe("loopback carve-out: isLoopbackLiteral() unit tests", () => {
  const LOOPBACK_FORMS = [
    "localhost",
    "LOCALHOST",
    "LocalHost",
    "ip6-localhost",
    "ip6-loopback",
    "127.0.0.1",
    "127.0.0.53",
    "127.1.2.3",
    "127.255.255.255",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
  ];

  // Everything the general guard blocks that the carve-out must NOT accept.
  const STILL_REFUSED = [
    "",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254", // cloud metadata — the crown jewel
    "169.254.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "::",
    "[::]",
    "fe80::1",
    "feb0::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "rebind.evil.test", // a name; only its RESOLUTION is loopback
    "api.example.com",
  ];

  for (const host of LOOPBACK_FORMS) {
    test(`"${host}" is a loopback literal AND was blocked by the general guard`, () => {
      expect(isLoopbackLiteral(host)).toBe(true);
      // Subset check: if this were false, the carve-out would be widening
      // something the general guard already permitted.
      expect(isPrivateOrLoopback(host)).toBe(true);
    });
  }

  for (const host of STILL_REFUSED) {
    test(`"${host}" is NOT a loopback literal (carve-out does not reach it)`, () => {
      expect(isLoopbackLiteral(host)).toBe(false);
    });
  }

  test("a public address is neither loopback-literal nor privately blocked", () => {
    expect(isLoopbackLiteral("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopback("8.8.8.8")).toBe(false);
    expect(isLoopbackLiteral("2001:4860:4860::8888")).toBe(false);
  });

  test("an unparseable IPv6 literal is not accepted by the carve-out", () => {
    expect(isLoopbackLiteral("[:::1]")).toBe(false);
    expect(isLoopbackLiteral("[::ffff:999.0.0.1]")).toBe(false);
  });
});

describe("loopback carve-out: loopbackProvidersBlocked() unit tests", () => {
  test("unset → not blocked (carve-out active by default)", () => {
    expect(loopbackProvidersBlocked({})).toBe(false);
  });

  test('"1" and "true" (any case, padded) → blocked', () => {
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "1" })).toBe(true);
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "true" })).toBe(true);
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "TRUE" })).toBe(true);
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: " true " })).toBe(true);
  });

  test("other values → not blocked (fails OPEN, matching the shipped default)", () => {
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "0" })).toBe(false);
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "false" })).toBe(false);
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "" })).toBe(false);
    expect(loopbackProvidersBlocked({ [BLOCK_LOOPBACK_ENV]: "yes" })).toBe(false);
  });

  test("the exported env name is the documented one", () => {
    expect(BLOCK_LOOPBACK_ENV).toBe("EZCORP_BLOCK_LOOPBACK_PROVIDERS");
  });
});
