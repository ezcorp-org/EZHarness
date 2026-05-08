/**
 * Pure-logic coverage for `src/extensions/runtime/network-wrapper.ts`.
 *
 * Matrix mirrors the Phase 2 spec's coverage list (a-k):
 *   (a) extension allowlist hit
 *   (b) extension allowlist miss
 *   (c) PERMITTED_HOSTS empty → all non-internal denied
 *   (d) per-tool override hit
 *   (e) per-tool override miss (extension allows host but not for this tool)
 *   (f) ALS unset → extension-wide allowlist only
 *   (g) localhost → internal lane
 *   (h) RFC-1918 → internal lane
 *   (i) link-local IPv6 → internal lane
 *   (j) URL / Request input shapes (the wrapper handles via `urlStr`,
 *       so this is the parser test)
 *   (k) malformed `EZCORP_TOOL_NETWORK_CAPS` → treat as empty
 */
import { test, expect, describe } from "bun:test";
import {
  classifyFetch,
  parsePermittedHosts,
  parseToolCaps,
  INTERNAL_HOST_RE,
} from "../extensions/runtime/network-wrapper";

const NO_TOOL_CAPS = {} as const;

describe("classifyFetch — extension allowlist (a, b, c)", () => {
  test("(a) host in PERMITTED_HOSTS → external lane", () => {
    const decision = classifyFetch("https://api.foo.com/v1", {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("external");
  });

  test("(b) host NOT in PERMITTED_HOSTS → deny with hostname in reason", () => {
    const decision = classifyFetch("https://evil.com/x", {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("evil.com");
      expect(decision.reason).toContain("api.foo.com");
    }
  });

  test("(c) PERMITTED_HOSTS empty → all non-internal denied", () => {
    const decision = classifyFetch("https://api.foo.com/", {
      permittedHosts: [],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      // No "granted: ..." clause when nothing was granted.
      expect(decision.reason).not.toContain("granted:");
    }
  });

  test("hostname is normalized to lowercase before allowlist lookup", () => {
    const decision = classifyFetch("https://API.FOO.com/", {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("external");
  });
});

describe("classifyFetch — per-tool override (d, e, f)", () => {
  test("(d) tool's hosts ⊇ {host} → external (override hit)", () => {
    const decision = classifyFetch("https://api.foo.com/", {
      permittedHosts: ["api.foo.com", "api.bar.com"],
      toolCaps: { t1: ["api.foo.com"] },
      toolName: "t1",
    });
    expect(decision.kind).toBe("external");
  });

  test("(e) tool's hosts ⊉ {host} → deny with tool name in reason", () => {
    const decision = classifyFetch("https://api.bar.com/", {
      permittedHosts: ["api.foo.com", "api.bar.com"],
      toolCaps: { t1: ["api.foo.com"] },
      toolName: "t1",
    });
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("t1");
      expect(decision.reason).toContain("api.bar.com");
    }
  });

  test("(f) ALS unset (toolName=undefined) → extension-wide allowlist only", () => {
    // Even if the per-tool map declares a narrower list, fetch outside a
    // tool handler (e.g. module init) bypasses the per-tool check.
    const decision = classifyFetch("https://api.bar.com/", {
      permittedHosts: ["api.foo.com", "api.bar.com"],
      toolCaps: { t1: ["api.foo.com"] },
      toolName: undefined,
    });
    expect(decision.kind).toBe("external");
  });

  test("tool with no entry in capabilities map inherits extension-wide ceiling", () => {
    // `t2` doesn't have its own host list — it inherits the extension's
    // grant set without further narrowing.
    const decision = classifyFetch("https://api.bar.com/", {
      permittedHosts: ["api.foo.com", "api.bar.com"],
      toolCaps: { t1: ["api.foo.com"] },
      toolName: "t2",
    });
    expect(decision.kind).toBe("external");
  });

  test("tool with empty array narrows to nothing (zero hosts allowed)", () => {
    // An author wanting to revoke a tool's network access can declare an
    // empty array. The wrapper enforces that.
    const decision = classifyFetch("https://api.foo.com/", {
      permittedHosts: ["api.foo.com"],
      toolCaps: { t1: [] },
      toolName: "t1",
    });
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("none");
    }
  });
});

describe("classifyFetch — internal hosts (g, h, i)", () => {
  test("(g) localhost → internal lane", () => {
    const decision = classifyFetch("http://localhost:3000/", {
      permittedHosts: [],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("internal");
  });

  test("127.0.0.1 → internal lane", () => {
    const decision = classifyFetch("http://127.0.0.1:5432/", {
      permittedHosts: [],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("internal");
  });

  test("::1 (IPv6 loopback) → internal lane", () => {
    const decision = classifyFetch("http://[::1]:5432/", {
      permittedHosts: [],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("internal");
  });

  test("(h) 10.x.x.x (RFC-1918 class A) → internal lane", () => {
    expect(
      classifyFetch("http://10.0.0.1/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("internal");
  });

  test("192.168.x.x (RFC-1918 class C) → internal lane", () => {
    expect(
      classifyFetch("http://192.168.1.1/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("internal");
  });

  test("172.16-31.x.x (RFC-1918 class B) → internal lane", () => {
    for (const second of [16, 20, 31]) {
      expect(
        classifyFetch(`http://172.${second}.0.1/`, {
          permittedHosts: [],
          toolCaps: NO_TOOL_CAPS,
        }).kind,
      ).toBe("internal");
    }
    // 172.15 and 172.32 are NOT private (boundary check)
    expect(
      classifyFetch("http://172.15.0.1/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("deny");
    expect(
      classifyFetch("http://172.32.0.1/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("deny");
  });

  test("169.254.x.x (link-local IPv4) → internal lane", () => {
    expect(
      classifyFetch("http://169.254.1.1/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("internal");
  });

  test("(i) fe80:* (link-local IPv6) → internal lane", () => {
    expect(
      classifyFetch("http://[fe80::1]/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("internal");
  });

  test("fc00:* / fd00:* (unique local IPv6) → internal lane", () => {
    expect(
      classifyFetch("http://[fc00::1]/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("internal");
    expect(
      classifyFetch("http://[fd00::1]/", { permittedHosts: [], toolCaps: NO_TOOL_CAPS }).kind,
    ).toBe("internal");
  });

  test("public IP (8.8.8.8) → external lane (not internal)", () => {
    // Public IPs go through the regular allowlist gate.
    const decision = classifyFetch("http://8.8.8.8/", {
      permittedHosts: ["8.8.8.8"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("external");
  });

  test("internal lane bypasses extension allowlist (host PDP gates instead)", () => {
    // The wrapper's job for internal hosts is to forward to the
    // reverse-RPC. The host PDP decides if the manifest declared this
    // specific internal host. The wrapper does NOT check
    // PERMITTED_HOSTS for internal lanes.
    const decision = classifyFetch("http://localhost:5432/", {
      permittedHosts: ["api.foo.com"], // unrelated grant
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("internal");
  });
});

describe("classifyFetch — invalid URLs", () => {
  test("malformed URL → invalid lane (rejected before any network attempt)", () => {
    const decision = classifyFetch("not a url", {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("invalid");
  });

  test("empty string → invalid lane", () => {
    const decision = classifyFetch("", {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("invalid");
  });
});

// ── (j) Input-shape narrowing — fetch(URL) / fetch(Request) ────────
//
// The wrapper at `sandbox-preload.ts:installFetchWrapper` accepts
// `string | URL | Request` and extracts a string URL via:
//   typeof input === "string" ? input
//     : input instanceof URL ? input.href
//     : (input as Request).url
//
// `classifyFetch` itself only takes a string — by design (pure logic,
// no Request/URL globals required for the host-side mirror). We mirror
// the wrapper's narrowing here so a regression in EITHER layer would
// trip the assertion. The narrowing function itself is a one-line
// helper duplicated here — keep in sync with sandbox-preload.ts.

function urlOfFetchInput(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("(j) fetch input-shape narrowing — string / URL / Request all reach classifyFetch", () => {
  test("fetch(string) → URL extracted verbatim", () => {
    const urlStr = urlOfFetchInput("https://api.foo.com/v1/x");
    expect(urlStr).toBe("https://api.foo.com/v1/x");
    const decision = classifyFetch(urlStr, {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("external");
  });

  test("fetch(new URL(...)) → .href extracted, classifier sees the same hostname", () => {
    const u = new URL("https://api.foo.com/v1/x?q=1");
    const urlStr = urlOfFetchInput(u);
    expect(urlStr).toBe("https://api.foo.com/v1/x?q=1");
    const decision = classifyFetch(urlStr, {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("external");
  });

  test("fetch(new Request(...)) → .url extracted, classifier sees the same hostname", () => {
    const r = new Request("https://api.foo.com/v1/x", { method: "POST" });
    const urlStr = urlOfFetchInput(r);
    expect(urlStr).toBe("https://api.foo.com/v1/x");
    const decision = classifyFetch(urlStr, {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("external");
  });

  test("fetch(URL) for a denied host → deny lane (not bypassed by URL-shape)", () => {
    const u = new URL("https://evil.com/x");
    const decision = classifyFetch(urlOfFetchInput(u), {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("deny");
  });

  test("fetch(Request) for an internal host → internal lane (not bypassed by Request-shape)", () => {
    const r = new Request("http://localhost:5432/healthz");
    const decision = classifyFetch(urlOfFetchInput(r), {
      permittedHosts: ["api.foo.com"],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("internal");
  });

  test("fetch(URL) for IPv6 host → bracket-stripped before classification (M1 regression guard)", () => {
    // The wrapper's `normalizeHostname` strips `[fc00::1]` → `fc00::1`
    // so the regex matches. A regression in the shared internal-host
    // module (the one introduced by this commit to fix M1) would let
    // the URL through to the external lane and land in deny.
    const u = new URL("http://[fc00::1]/");
    const decision = classifyFetch(urlOfFetchInput(u), {
      permittedHosts: [],
      toolCaps: NO_TOOL_CAPS,
    });
    expect(decision.kind).toBe("internal");
  });
});

describe("INTERNAL_HOST_RE — direct matrix", () => {
  test("matches every documented internal pattern", () => {
    const internal = [
      "localhost",
      "127.0.0.1",
      "::1",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.169.254",
      "fc00::1",
      "fd00::1",
      "fe80::1",
    ];
    for (const h of internal) {
      expect(INTERNAL_HOST_RE.test(h)).toBe(true);
    }
  });

  test("rejects every documented external pattern", () => {
    const external = [
      "8.8.8.8",
      "1.1.1.1",
      "api.foo.com",
      "172.15.0.1",
      "172.32.0.1",
      "11.0.0.1",
      "200.0.0.1",
    ];
    for (const h of external) {
      expect(INTERNAL_HOST_RE.test(h)).toBe(false);
    }
  });
});

describe("parsePermittedHosts", () => {
  test("undefined → []", () => {
    expect(parsePermittedHosts(undefined)).toEqual([]);
  });

  test("empty string → []", () => {
    expect(parsePermittedHosts("")).toEqual([]);
  });

  test("whitespace-only commas → []", () => {
    expect(parsePermittedHosts(" , , ,")).toEqual([]);
  });

  test("normalizes case + trims whitespace", () => {
    expect(parsePermittedHosts("  Api.Foo.COM  , bar.io ")).toEqual([
      "api.foo.com",
      "bar.io",
    ]);
  });

  test("filters empty entries between commas", () => {
    expect(parsePermittedHosts("a.com,,b.com")).toEqual(["a.com", "b.com"]);
  });
});

describe("parseToolCaps — (k) malformed JSON falls back to empty", () => {
  test("undefined → {}", () => {
    expect(parseToolCaps(undefined)).toEqual({});
  });

  test("empty string → {}", () => {
    expect(parseToolCaps("")).toEqual({});
  });

  test("malformed JSON → {} (does NOT throw)", () => {
    expect(parseToolCaps("not-json{")).toEqual({});
  });

  test("array (not object) → {} (parses but rejects shape)", () => {
    expect(parseToolCaps(`["t1"]`)).toEqual({});
  });

  test("null → {}", () => {
    expect(parseToolCaps("null")).toEqual({});
  });

  test("valid map → string[] entries with lowercased hosts", () => {
    expect(parseToolCaps(`{"t1":["API.foo.com","Bar.io"],"t2":[]}`)).toEqual({
      t1: ["api.foo.com", "bar.io"],
      t2: [],
    });
  });

  test("non-string array entries are dropped (whole entry skipped)", () => {
    // Defensive: a tampered map with non-strings shouldn't widen the
    // allowlist or crash the wrapper.
    expect(parseToolCaps(`{"t1":[42,"foo.com"],"t2":["bar.com"]}`)).toEqual({
      t2: ["bar.com"],
    });
  });

  test("non-object entry value → entry dropped", () => {
    expect(parseToolCaps(`{"t1":"not-array","t2":["foo.com"]}`)).toEqual({
      t2: ["foo.com"],
    });
  });
});
