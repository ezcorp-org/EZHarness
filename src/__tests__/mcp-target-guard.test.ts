/**
 * SSRF guard for outbound MCP targets (`src/mcp/target-guard.ts`).
 *
 * Pure policy — no DB, no sockets, no real DNS except where a test says so
 * explicitly. The resolver is injected so multi-record and DNS-rebinding
 * cases are deterministic.
 *
 * The security property under test: an admin-scoped caller cannot make the
 * server dial cloud metadata, loopback, or any RFC-1918 / CGNAT / IPv6
 * internal address, in ANY spelling the WHATWG URL parser accepts — unless
 * the operator explicitly vouched for it via EZCORP_MCP_TARGET_ALLOW.
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
  assertMcpTargetAllowed,
  assertMcpTargetUrlAllowed,
  McpTargetBlockedError,
  MCP_TARGET_ALLOW_ENV,
  parseMcpTargetAllowlist,
  resetAllowlistWarnings,
  UNPARSEABLE_TARGET,
  warnAboutAllowlist,
  type McpTargetBlockReason,
} from "../mcp/target-guard";
import type { McpServerDefinition } from "../extensions/types";

/** Deterministic resolver. Unknown names resolve to nothing. */
function resolverFor(map: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => map[hostname] ?? [];
}

const PUBLIC_IP = "93.184.216.34";
const resolveHost = resolverFor({
  "pub.test": [PUBLIC_IP],
  "mcp.lan": ["192.168.1.50"],
  // Round-robin DNS mixing a public and a private answer — the classic
  // smuggle: a lucky first address looks fine, the second is internal.
  "mixed.test": [PUBLIC_IP, "10.0.0.5"],
  "private-only.test": ["10.0.0.5"],
  "nxdomain.test": [],
  // A resolver answer that isn't an address at all.
  "junk.test": ["not-an-ip"],
});

/** Run the guard and report the outcome as a comparable string. */
async function verdict(url: string, allowRaw = ""): Promise<string> {
  try {
    await assertMcpTargetUrlAllowed(url, { resolveHost, allowRaw });
    return "ALLOW";
  } catch (e) {
    if (e instanceof McpTargetBlockedError) return `BLOCK:${e.reason}`;
    throw e;
  }
}

async function blockedBy(url: string, allowRaw = ""): Promise<McpTargetBlockedError> {
  try {
    await assertMcpTargetUrlAllowed(url, { resolveHost, allowRaw });
  } catch (e) {
    if (e instanceof McpTargetBlockedError) return e;
    throw e;
  }
  throw new Error(`expected ${url} to be blocked, but it was allowed`);
}

describe("blocked address ranges (IPv4 literals)", () => {
  // Every range the guard must refuse, one representative each. A regression
  // that drops any single line here is an SSRF hole, so they are asserted
  // individually rather than as a set.
  const blocked: Array<[string, string]> = [
    ["cloud metadata", "169.254.169.254"],
    ["link-local", "169.254.10.1"],
    ["loopback", "127.0.0.1"],
    ["loopback /8 edge", "127.255.255.254"],
    ["RFC1918 10/8", "10.0.0.5"],
    ["RFC1918 172.16/12 low", "172.16.0.1"],
    ["RFC1918 172.16/12 high", "172.31.255.254"],
    ["RFC1918 192.168/16", "192.168.1.50"],
    ["CGNAT 100.64/10 low", "100.64.0.1"],
    ["CGNAT 100.64/10 high", "100.127.255.254"],
    ["unspecified 0/8", "0.0.0.0"],
  ];
  for (const [label, ip] of blocked) {
    test(`refuses ${label} (${ip})`, async () => {
      expect(await verdict(`http://${ip}:8080/mcp`)).toBe("BLOCK:private-address");
    });
  }

  test("allows a public IPv4 literal", async () => {
    expect(await verdict(`http://${PUBLIC_IP}:8080/mcp`)).toBe("ALLOW");
  });

  test("public IPv4 just outside 172.16/12 is allowed", async () => {
    // 172.32/12 is public; an off-by-one in the mask would over-block it.
    expect(await verdict("http://172.32.0.1/mcp")).toBe("ALLOW");
  });
});

describe("blocked address ranges (IPv6 literals)", () => {
  const blocked: Array<[string, string]> = [
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["unique-local fc00::/7", "fc00::1"],
    ["unique-local fd00::", "fd00::1"],
    ["AWS IPv6 metadata", "fd00:ec2::254"],
    ["link-local fe80::/10", "fe80::1"],
    ["site-local fec0::/10", "fec0::1"],
    ["v4-mapped loopback", "::ffff:127.0.0.1"],
    ["v4-mapped metadata", "::ffff:169.254.169.254"],
    ["v4-compatible loopback", "::7f00:1"],
    ["6to4 wrapping loopback", "2002:7f00:1::"],
    ["NAT64 wrapping loopback", "64:ff9b::7f00:1"],
  ];
  for (const [label, ip] of blocked) {
    test(`refuses ${label} (${ip})`, async () => {
      expect(await verdict(`http://[${ip}]:8080/mcp`)).toBe("BLOCK:private-address");
    });
  }

  test("allows a public IPv6 literal", async () => {
    expect(await verdict("http://[2606:4700:4700::1111]/mcp")).toBe("ALLOW");
  });

  test("6to4 wrapping a PUBLIC v4 stays allowed (no over-block)", async () => {
    // 2002:<public-v4>:: is a legitimate public address; only the
    // embedded-private case is refused.
    expect(await verdict("http://[2002:5db8:d822::]/mcp")).toBe("ALLOW");
  });
});

describe("alternate IPv4 spellings the URL parser normalizes", () => {
  // WHATWG `new URL` rewrites these to dotted-quad before we ever see them.
  // The test pins that the guard benefits from it rather than assuming a
  // dotted form — each of these reaches 127.0.0.1.
  const spellings = ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"];
  for (const spelling of spellings) {
    test(`refuses non-dotted loopback form ${spelling}`, async () => {
      expect(await verdict(`http://${spelling}/mcp`)).toBe("BLOCK:private-address");
    });
  }
});

describe("DNS-resolved hostnames", () => {
  test("allows a hostname that resolves to a single public address", async () => {
    expect(await verdict("http://pub.test/mcp")).toBe("ALLOW");
  });

  test("refuses a hostname whose only address is private", async () => {
    expect(await verdict("http://private-only.test/mcp")).toBe("BLOCK:private-address");
  });

  test("refuses a multi-A hostname when ANY address is private", async () => {
    // The public answer comes FIRST; a guard that checked only the pinned
    // address would allow this and hand the connection to round-robin DNS.
    const err = await blockedBy("http://mixed.test/mcp");
    expect(err.reason).toBe("private-address");
    expect(err.target).toBe("mixed.test → 10.0.0.5");
  });

  test("refuses a hostname that resolves to nothing", async () => {
    expect(await verdict("http://nxdomain.test/mcp")).toBe("BLOCK:no-address");
  });

  test("refuses when the resolver throws", async () => {
    const throwing = async () => {
      throw new Error("EAI_AGAIN");
    };
    try {
      await assertMcpTargetUrlAllowed("http://whatever.test/mcp", {
        resolveHost: throwing,
        allowRaw: "",
      });
      throw new Error("expected a block");
    } catch (e) {
      expect(e).toBeInstanceOf(McpTargetBlockedError);
      expect((e as McpTargetBlockedError).reason).toBe("no-address");
    }
  });

  test("refuses an unparseable resolver answer (fails closed)", async () => {
    expect(await verdict("http://junk.test/mcp")).toBe("BLOCK:private-address");
  });

  test("an IP literal is classified directly, never through the resolver", async () => {
    // A resolver that would ALLOW everything must not be able to launder a
    // literal metadata address.
    let called = false;
    const permissive = async () => {
      called = true;
      return [PUBLIC_IP];
    };
    const err = await (async () => {
      try {
        await assertMcpTargetUrlAllowed("http://169.254.169.254/latest/meta-data/", {
          resolveHost: permissive,
          allowRaw: "",
        });
        return null;
      } catch (e) {
        return e as McpTargetBlockedError;
      }
    })();
    expect(err).toBeInstanceOf(McpTargetBlockedError);
    expect(err!.reason).toBe("private-address");
    expect(called).toBe(false);
  });
});

describe("URL edge cases", () => {
  test("userinfo credentials never appear in the block target", async () => {
    const err = await blockedBy("http://admin:hunter2@169.254.169.254/latest/");
    expect(err.target).toBe("169.254.169.254 → 169.254.169.254");
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("admin");
  });

  test("a port does not change the verdict", async () => {
    expect(await verdict("http://10.0.0.5:6379/")).toBe("BLOCK:private-address");
    expect(await verdict(`http://${PUBLIC_IP}:6379/`)).toBe("ALLOW");
  });

  test("a trailing root dot resolves to the same name", async () => {
    expect(await verdict("http://pub.test./mcp")).toBe("ALLOW");
    expect(await verdict("http://private-only.test./mcp")).toBe("BLOCK:private-address");
  });

  test("hostname case is normalized", async () => {
    expect(await verdict("http://PUB.TEST/mcp")).toBe("ALLOW");
  });

  test("https is accepted", async () => {
    expect(await verdict("https://pub.test/mcp")).toBe("ALLOW");
  });

  test("refuses a non-http(s) scheme", async () => {
    const err = await blockedBy("ftp://pub.test/mcp");
    expect(err.reason).toBe("scheme");
    expect(err.target).toBe("ftp:");
  });

  test("refuses file: and gopher: schemes", async () => {
    expect(await verdict("file:///etc/passwd")).toBe("BLOCK:scheme");
    expect(await verdict("gopher://pub.test:70/")).toBe("BLOCK:scheme");
  });

  test("refuses an unparseable URL without echoing it", async () => {
    const err = await blockedBy("not a url at all");
    expect(err.reason).toBe("malformed-url");
    expect(err.target).toBe(UNPARSEABLE_TARGET);
    expect(err.message).not.toContain("not a url");
  });

  test("the error carries a stable code and name", async () => {
    const err = await blockedBy("http://10.0.0.5/");
    expect(err.code).toBe("MCP_TARGET_BLOCKED");
    expect(err.name).toBe("McpTargetBlockedError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("allowlist parsing", () => {
  test("an absent allowlist allows nothing extra", () => {
    const parsed = parseMcpTargetAllowlist(undefined);
    expect(parsed.hosts.size).toBe(0);
    expect(parsed.nets.length).toBe(0);
  });

  test("an empty / whitespace-only allowlist parses to nothing", () => {
    expect(parseMcpTargetAllowlist("").nets.length).toBe(0);
    expect(parseMcpTargetAllowlist("   ").hosts.size).toBe(0);
    expect(parseMcpTargetAllowlist(null).nets.length).toBe(0);
  });

  test("splits on commas and whitespace and lowercases hosts", () => {
    const parsed = parseMcpTargetAllowlist("MCP.LAN, other.host\ninternal.svc");
    expect([...parsed.hosts].sort()).toEqual(["internal.svc", "mcp.lan", "other.host"]);
  });

  test("bare IP literals become full-length prefixes", () => {
    const parsed = parseMcpTargetAllowlist("127.0.0.1, ::1");
    expect(parsed.nets.length).toBe(2);
    expect(parsed.hosts.size).toBe(0);
    // A v4 entry is stored in the v4-mapped block: /32 counted from bit 96.
    expect(parsed.nets[0]!.prefix).toBe(128);
    expect(parsed.nets[1]!.prefix).toBe(128);
  });

  test("CIDR entries keep their prefix (v4 shifted into the mapped block)", () => {
    const parsed = parseMcpTargetAllowlist("10.0.0.0/8, fd00::/8");
    expect(parsed.nets.map((n) => n.prefix)).toEqual([104, 8]);
  });

  test("bracketed IPv6 entries are accepted", () => {
    const parsed = parseMcpTargetAllowlist("[::1]");
    expect(parsed.nets.length).toBe(1);
  });

  test("drops entries with an out-of-range prefix", () => {
    expect(parseMcpTargetAllowlist("10.0.0.0/33").nets.length).toBe(0);
    expect(parseMcpTargetAllowlist("fd00::/129").nets.length).toBe(0);
  });

  test("drops entries with a non-numeric prefix", () => {
    expect(parseMcpTargetAllowlist("10.0.0.0/eight").nets.length).toBe(0);
  });

  test("drops an address `isIP` accepts but has no fixed byte form", () => {
    // A scoped IPv6 literal — `isIP` says 6, the byte parser says no.
    expect(parseMcpTargetAllowlist("fe80::1%eth0/64").nets.length).toBe(0);
  });

  test("drops a hostname that carries a path (a URL pasted into the list)", () => {
    const parsed = parseMcpTargetAllowlist("mcp.lan/mcp");
    expect(parsed.hosts.size).toBe(0);
    expect(parsed.nets.length).toBe(0);
  });

  test("drops a bare slash", () => {
    const parsed = parseMcpTargetAllowlist("/");
    expect(parsed.hosts.size).toBe(0);
    expect(parsed.nets.length).toBe(0);
  });

  test("a malformed entry never widens the allowlist", async () => {
    // The only entry is garbage, so the private target stays refused.
    expect(await verdict("http://10.0.0.5/", "10.0.0.0/99")).toBe("BLOCK:private-address");
  });
});

describe("allowlist enforcement", () => {
  test("a CIDR entry permits an address inside it", async () => {
    expect(await verdict("http://10.0.0.5:6379/", "10.0.0.0/8")).toBe("ALLOW");
  });

  test("a CIDR entry does NOT permit an address outside it", async () => {
    // Allowing the LAN must not also allow cloud metadata.
    expect(await verdict("http://169.254.169.254/latest/", "10.0.0.0/8")).toBe(
      "BLOCK:private-address",
    );
    expect(await verdict("http://192.168.1.50/", "10.0.0.0/8")).toBe("BLOCK:private-address");
  });

  test("a narrow CIDR respects its boundary", async () => {
    expect(await verdict("http://192.168.1.50/", "192.168.1.0/24")).toBe("ALLOW");
    expect(await verdict("http://192.168.2.50/", "192.168.1.0/24")).toBe("BLOCK:private-address");
  });

  test("a non-byte-aligned prefix masks correctly", async () => {
    // 10.0.0.0/12 covers 10.0.x.x–10.15.x.x only.
    expect(await verdict("http://10.15.255.254/", "10.0.0.0/12")).toBe("ALLOW");
    expect(await verdict("http://10.16.0.1/", "10.0.0.0/12")).toBe("BLOCK:private-address");
  });

  test("a bare IP entry permits exactly that address", async () => {
    expect(await verdict("http://127.0.0.1:3000/mcp", "127.0.0.1")).toBe("ALLOW");
    expect(await verdict("http://127.0.0.2:3000/mcp", "127.0.0.1")).toBe("BLOCK:private-address");
  });

  test("an IPv6 entry permits an IPv6 target", async () => {
    expect(await verdict("http://[::1]:3000/mcp", "::1")).toBe("ALLOW");
    expect(await verdict("http://[fd00::1]/mcp", "fd00::/8")).toBe("ALLOW");
  });

  test("a v4 CIDR does not leak into the IPv6 space", async () => {
    expect(await verdict("http://[fd00::1]/mcp", "10.0.0.0/8")).toBe("BLOCK:private-address");
  });

  test("a v6 CIDR does not leak into the IPv4 space", async () => {
    expect(await verdict("http://10.0.0.5/", "fd00::/8")).toBe("BLOCK:private-address");
  });

  test("a v4 CIDR also covers the v4-mapped spelling of the same host", async () => {
    expect(await verdict("http://[::ffff:10.0.0.5]/mcp", "10.0.0.0/8")).toBe("ALLOW");
  });

  test("a zero-length IPv6 prefix allows every address (operator opt-out)", async () => {
    expect(await verdict("http://[fd00::1]/mcp", "::/0")).toBe("ALLOW");
  });

  test("a hostname entry vouches for the name regardless of its address", async () => {
    expect(await verdict("http://mcp.lan/mcp", "mcp.lan")).toBe("ALLOW");
  });

  test("a hostname entry does NOT vouch for a different name on the same address", async () => {
    // private-only.test also resolves into RFC1918, but was not vouched for.
    expect(await verdict("http://private-only.test/mcp", "mcp.lan")).toBe(
      "BLOCK:private-address",
    );
  });

  test("a hostname entry does not bypass the scheme gate", async () => {
    expect(await verdict("ftp://mcp.lan/mcp", "mcp.lan")).toBe("BLOCK:scheme");
  });

  test("an allowlisted hostname still matches with a trailing root dot", async () => {
    expect(await verdict("http://mcp.lan./mcp", "mcp.lan")).toBe("ALLOW");
  });

  test("multiple entries compose", async () => {
    const allow = "127.0.0.1, 10.0.0.0/8, mcp.lan";
    expect(await verdict("http://127.0.0.1:3000/", allow)).toBe("ALLOW");
    expect(await verdict("http://10.9.9.9/", allow)).toBe("ALLOW");
    expect(await verdict("http://mcp.lan/", allow)).toBe("ALLOW");
    expect(await verdict("http://169.254.169.254/", allow)).toBe("BLOCK:private-address");
  });
});

describe("allowlist spellings an operator actually types", () => {
  // These four were MEASURED failing silently. Each produced "I set the
  // documented variable and my LAN server still won't install, and the 502
  // tells me to set the variable I already set." Two of them landed in the
  // `hosts` set — the validation-SKIPPING form — so a typo was also the less
  // safe outcome. Every one is now rejected BY VALUE, or parsed correctly.
  test("host:port is rejected loudly, not turned into a host vouch", () => {
    const parsed = parseMcpTargetAllowlist("192.168.1.50:8080");
    expect([...parsed.hosts]).toEqual([]);
    expect(parsed.nets).toHaveLength(0);
    expect(parsed.problems.join()).toContain('"192.168.1.50:8080"');
    expect(parsed.problems.join()).toContain("host:port");
  });

  test("a pasted URL is rejected loudly", () => {
    const parsed = parseMcpTargetAllowlist("http://192.168.1.50");
    expect([...parsed.hosts]).toEqual([]);
    expect(parsed.problems.join()).toContain('"http://192.168.1.50"');
    expect(parsed.problems.join()).toContain("URL");
  });

  test("semicolons separate entries instead of destroying both", () => {
    const parsed = parseMcpTargetAllowlist("10.0.0.0/8;172.16.0.0/12");
    // /8 and /12 in the v4-mapped block.
    expect(parsed.nets.map((n) => n.prefix)).toEqual([104, 108]);
    expect(parsed.problems).toHaveLength(0);
  });

  test("spaces around a CIDR slash are reported, not silently narrowed", () => {
    // `10.0.0.0 / 8` splits into three tokens. The bare IP is still a valid
    // /32 (we cannot know it was meant as /8), but the operator now gets two
    // warnings naming exactly what was thrown away — previously the /8
    // became a /32, 16.7M addresses narrower, in total silence.
    const parsed = parseMcpTargetAllowlist("10.0.0.0 / 8");
    expect([...parsed.hosts]).toEqual([]);
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems.join()).toContain("CIDR");
    // The stray prefix is NOT accepted as a hostname vouch any more.
    expect(parsed.problems.join()).toContain('"8"');
  });

  test("a well-formed list still parses with no complaints", () => {
    const parsed = parseMcpTargetAllowlist("127.0.0.1, ::1, 10.0.0.0/8, mcp.lan");
    expect([...parsed.hosts]).toEqual(["mcp.lan"]);
    expect(parsed.nets).toHaveLength(3);
    expect(parsed.problems).toHaveLength(0);
  });

  test("a malformed hostname is rejected rather than vouched for", () => {
    expect(parseMcpTargetAllowlist("not_a_host!").problems.join()).toContain("not a valid hostname");
    expect([...parseMcpTargetAllowlist("not_a_host!").hosts]).toEqual([]);
  });

  test("a CIDR whose left side is not an IP is rejected", () => {
    const parsed = parseMcpTargetAllowlist("mcp.lan/24");
    expect(parsed.problems.join()).toContain("must be an IP");
    expect([...parsed.hosts]).toEqual([]);
  });

  test("an out-of-range or non-numeric prefix names the value", () => {
    expect(parseMcpTargetAllowlist("10.0.0.0/33").problems.join()).toContain("out of range");
    expect(parseMcpTargetAllowlist("10.0.0.0/eight").problems.join()).toContain("not a number");
  });

  test("a scoped IPv6 literal is reported", () => {
    expect(parseMcpTargetAllowlist("fe80::1%eth0/64").problems.join()).toContain("byte form");
  });
});

describe("allowlist problems reach the operator's log", () => {
  afterEach(() => resetAllowlistWarnings());

  test("every dropped entry is warned by value", () => {
    const lines: string[] = [];
    warnAboutAllowlist("192.168.1.50:8080, http://10.0.0.1", { warn: (m) => lines.push(m) });
    expect(lines).toHaveLength(2);
    expect(lines.join()).toContain("192.168.1.50:8080");
    expect(lines.join()).toContain("http://10.0.0.1");
    expect(lines.every((l) => l.includes(MCP_TARGET_ALLOW_ENV))).toBe(true);
  });

  test("a clean allowlist produces no noise", () => {
    const lines: string[] = [];
    warnAboutAllowlist("127.0.0.1,::1", { warn: (m) => lines.push(m) });
    expect(lines).toEqual([]);
  });

  test("the same raw value is reported once, not once per request", () => {
    // The guard re-reads the env on every MCP request; without de-duplication
    // a typo would print on every tool call.
    const lines: string[] = [];
    const log = { warn: (m: string) => lines.push(m) };
    warnAboutAllowlist("bad:8080", log);
    warnAboutAllowlist("bad:8080", log);
    warnAboutAllowlist("bad:8080", log);
    expect(lines).toHaveLength(1);
  });

  test("the guard itself emits the warning alongside the denial", async () => {
    const lines: string[] = [];
    await expect(
      assertMcpTargetUrlAllowed("http://10.0.0.5/mcp", {
        resolveHost,
        allowRaw: "10.0.0.5:9000",
        logger: { warn: (m) => lines.push(m) },
      }),
    ).rejects.toBeInstanceOf(McpTargetBlockedError);
    // The denial is opaque at the API; this log line is the only place the
    // operator can learn their entry was not understood.
    expect(lines.join()).toContain("10.0.0.5:9000");
  });
});

describe("the DNS lookup is bounded", () => {
  test("a resolver that never settles is refused, not waited on", async () => {
    // Measured against a blackholed nameserver, a bare dns.lookup took ~24s
    // to fail — an API handler occupied for half a minute, and a stalled
    // chat turn on the first tool dispatch. The never-settling resolver here
    // makes the outcome deterministic: only the deadline can win the race,
    // regardless of host load.
    const never = () => new Promise<string[]>(() => {});
    const err = await assertMcpTargetUrlAllowed("http://slow.test/mcp", {
      resolveHost: never,
      allowRaw: "",
      resolveTimeoutMs: 5,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(McpTargetBlockedError);
    // Collapses into the existing uniform 502 — no new response shape.
    expect((err as McpTargetBlockedError).reason).toBe("no-address");
  });

  test("a resolver that answers in time is unaffected", async () => {
    await expect(
      assertMcpTargetUrlAllowed("http://pub.test/mcp", {
        resolveHost,
        allowRaw: "",
        resolveTimeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();
  });

  test("an IP literal never waits on the resolver at all", async () => {
    // No lookup happens, so a hung resolver cannot stall a literal target.
    const never = () => new Promise<string[]>(() => {});
    const err = await assertMcpTargetUrlAllowed("http://169.254.169.254/x", {
      resolveHost: never,
      allowRaw: "",
      resolveTimeoutMs: 50_000,
    }).catch((e) => e);
    expect((err as McpTargetBlockedError).reason).toBe("private-address");
  });
});

describe("localhost is dual-stack, and both addresses must be allowed", () => {
  // The trap an operator hits when they trim the documented example down to
  // "the one they think they need". Same shape as the SEARXNG_BASE_URL note
  // already in docker-compose.yml.
  const dualStack = async (host: string) =>
    host === "localhost" ? ["127.0.0.1", "::1"] : [];

  test("allowing only 127.0.0.1 still denies a localhost URL", async () => {
    const err = await assertMcpTargetUrlAllowed("http://localhost:3000/mcp", {
      resolveHost: dualStack,
      allowRaw: "127.0.0.1",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(McpTargetBlockedError);
    expect((err as McpTargetBlockedError).target).toContain("::1");
  });

  test("allowing both spellings works", async () => {
    await expect(
      assertMcpTargetUrlAllowed("http://localhost:3000/mcp", {
        resolveHost: dualStack,
        allowRaw: "127.0.0.1,::1",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("environment escape hatch", () => {
  const previous = process.env[MCP_TARGET_ALLOW_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[MCP_TARGET_ALLOW_ENV];
    else process.env[MCP_TARGET_ALLOW_ENV] = previous;
  });

  test(`${MCP_TARGET_ALLOW_ENV} is read when no allowlist is injected`, async () => {
    process.env[MCP_TARGET_ALLOW_ENV] = "10.0.0.0/8";
    await expect(
      assertMcpTargetUrlAllowed("http://10.0.0.5:6379/", { resolveHost }),
    ).resolves.toBeUndefined();
  });

  test("the env default denies when unset", async () => {
    delete process.env[MCP_TARGET_ALLOW_ENV];
    let reason: McpTargetBlockReason | null = null;
    try {
      await assertMcpTargetUrlAllowed("http://10.0.0.5:6379/", { resolveHost });
    } catch (e) {
      reason = (e as McpTargetBlockedError).reason;
    }
    expect(reason).toBe("private-address");
  });

  test("the default resolver is used when none is injected", async () => {
    // An IP literal needs no lookup, so this exercises the default-deps
    // path with zero real network.
    delete process.env[MCP_TARGET_ALLOW_ENV];
    await expect(assertMcpTargetUrlAllowed("http://169.254.169.254/latest/")).rejects.toBeInstanceOf(
      McpTargetBlockedError,
    );
  });
});

describe("spec-level entry point", () => {
  test("stdio specs are exempt (no network target)", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio",
      name: "local",
      command: "npx",
      args: ["some-mcp"],
    };
    // Must not throw, and must not consult the resolver.
    let called = false;
    await assertMcpTargetAllowed(spec, {
      resolveHost: async () => {
        called = true;
        return [];
      },
      allowRaw: "",
    });
    expect(called).toBe(false);
  });

  test("http specs are validated", async () => {
    const spec: McpServerDefinition = {
      transport: "http",
      name: "remote",
      url: "http://169.254.169.254/latest/meta-data/",
    };
    await expect(
      assertMcpTargetAllowed(spec, { resolveHost, allowRaw: "" }),
    ).rejects.toBeInstanceOf(McpTargetBlockedError);
  });

  test("sse specs are validated", async () => {
    const spec: McpServerDefinition = {
      transport: "sse",
      name: "remote",
      url: "http://10.0.0.5/sse",
    };
    await expect(
      assertMcpTargetAllowed(spec, { resolveHost, allowRaw: "" }),
    ).rejects.toBeInstanceOf(McpTargetBlockedError);
  });

  test("a public http spec passes", async () => {
    const spec: McpServerDefinition = {
      transport: "http",
      name: "remote",
      url: "https://pub.test/mcp",
    };
    await expect(
      assertMcpTargetAllowed(spec, { resolveHost, allowRaw: "" }),
    ).resolves.toBeUndefined();
  });
});
