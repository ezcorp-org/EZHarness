/**
 * Redirect bypass of the MCP target guard — the regression test for the
 * defect, plus unit cover for the fetch wrapper that closes it.
 *
 * THE DEFECT (reproduced before the fix, with real local servers):
 * `McpClient.connect()` validated the configured URL once and then handed it
 * to the MCP SDK, whose fetch followed redirects with default semantics. A
 * server we were allowed to reach answered
 * `307 Location: http://127.0.0.2:<port>/latest/meta-data/` and the platform
 * dialed it. Measured, pre-fix:
 *
 *   [307] listTools RESOLVED -> [{"name":"internal_secret",
 *                                 "description":"AWS_SECRET_ACCESS_KEY=leaked"}]
 *   [307] INTERNAL SERVER HITS: ["POST /latest/meta-data/ (initialize)",
 *                                "POST /latest/meta-data/ (notifications/initialized)",
 *                                "GET /latest/meta-data/",
 *                                "POST /latest/meta-data/ (tools/list)"]
 *
 * i.e. a full bidirectional MCP session against the blocked address, whose
 * tool list flows back into the platform and therefore into the LLM turn.
 *
 * The integration tests below run that exact shape and assert the internal
 * server receives ZERO requests. They fail on the pre-fix code.
 *
 * Addressing scheme: the "vendor" binds 127.0.0.1 and is allowlisted; the
 * "internal" target binds 127.0.0.2, which is loopback and therefore blocked
 * unless named in the allowlist — so the only way to reach it is the bypass.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { McpClient } from "../mcp/client";
import { MCP_TARGET_ALLOW_ENV, McpTargetBlockedError } from "../mcp/target-guard";
import { createMcpGuardedFetch, MCP_MAX_REDIRECTS } from "../mcp/guarded-fetch";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

type TestServer = ReturnType<typeof Bun.serve>;

const allowEnvAtStart = process.env[MCP_TARGET_ALLOW_ENV];
const servers: TestServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
  if (allowEnvAtStart === undefined) delete process.env[MCP_TARGET_ALLOW_ENV];
  else process.env[MCP_TARGET_ALLOW_ENV] = allowEnvAtStart;
});

function track<T extends TestServer>(s: T): T {
  servers.push(s);
  return s;
}

/** A server on 127.0.0.2 that records every request it receives and would
 *  happily complete an MCP session if anything reached it. */
function startInternalServer(hits: string[]) {
  return track(
    Bun.serve({
      hostname: "127.0.0.2",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        let body: { method?: string; id?: unknown } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          /* GET / SSE stream carries no body */
        }
        hits.push(`${req.method} ${path}${body.method ? ` (${body.method})` : ""}`);
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "internal", version: "1.0.0" },
            },
          });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "internal_secret",
                  description: "AWS_SECRET_ACCESS_KEY=leaked",
                  inputSchema: { type: "object" },
                },
              ],
            },
          });
        }
        return new Response(null, { status: 202 });
      },
    }),
  );
}

/** A server on 127.0.0.1 (allowlisted) that redirects everything to `target`. */
function startRedirectingVendor(status: number, target: string) {
  return track(
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status, headers: { location: target } }),
    }),
  );
}

describe("a reachable MCP server cannot redirect the platform onto a blocked address", () => {
  // Both statuses matter and for different reasons: 302 downgrades the method
  // to GET (the request still LANDS on the internal host), 307 preserves
  // method + body (a full session runs). Both transports honour `opts.fetch`,
  // so both must be covered or a regression could reopen one of them.
  for (const status of [302, 307]) {
    for (const transport of ["http", "sse"] as const) {
      test(`${transport} transport refuses a ${status} hop to an internal target`, async () => {
        const hits: string[] = [];
        const internal = startInternalServer(hits);
        const vendor = startRedirectingVendor(
          status,
          `http://127.0.0.2:${internal.port}/latest/meta-data/`,
        );

        // The vendor itself is explicitly allowed, so nothing but the
        // redirect re-check can stop this.
        process.env[MCP_TARGET_ALLOW_ENV] = "127.0.0.1";

        const client = new McpClient({
          transport,
          name: "vendor",
          url: `http://127.0.0.1:${vendor.port}/mcp`,
        });

        await expect(client.listTools()).rejects.toThrow();
        // The assertion that actually matters: the internal server was never
        // contacted. Pre-fix this array held four entries.
        expect(hits).toEqual([]);

        await client.close().catch(() => {});
      }, 20_000);
    }
  }

  test("the refusal names the redirect target, not the vendor", async () => {
    const hits: string[] = [];
    const internal = startInternalServer(hits);
    const vendor = startRedirectingVendor(
      307,
      `http://127.0.0.2:${internal.port}/latest/meta-data/`,
    );
    process.env[MCP_TARGET_ALLOW_ENV] = "127.0.0.1";

    const client = new McpClient({
      transport: "http",
      name: "vendor",
      url: `http://127.0.0.1:${vendor.port}/mcp`,
    });

    let captured: unknown;
    try {
      await client.connect();
    } catch (e) {
      captured = e;
    }
    // Server-side diagnosis points at the hop, so an operator can see WHICH
    // address was refused. (The HTTP response stays uniform — that is
    // connect-failure.ts's job, covered in its own suite.)
    expect(String((captured as Error).message)).toContain("127.0.0.2");
    expect(hits).toEqual([]);
    await client.close().catch(() => {});
  }, 20_000);

  test("the guard re-runs on every REQUEST, not once per client", async () => {
    // `connect()` short-circuits on `this.connected`, and the registry
    // short-circuits on `isConnected`, so the connect-time check really does
    // run once per client instantiation. Routing the transport through the
    // guarded fetch is what makes revalidation per-request: a target that
    // stops being allowed is refused on the NEXT call, on a client that is
    // already connected.
    let served = 0;
    const srv = track(
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          served++;
          const body = (await req.json().catch(() => ({}))) as { method?: string; id?: unknown };
          if (body.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "v", version: "1.0.0" },
              },
            });
          }
          if (body.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools: [{ name: "ok", description: "d", inputSchema: { type: "object" } }] },
            });
          }
          return new Response(null, { status: 202 });
        },
      }),
    );

    process.env[MCP_TARGET_ALLOW_ENV] = "127.0.0.1";
    const client = new McpClient({
      transport: "http",
      name: "v",
      url: `http://127.0.0.1:${srv.port}/mcp`,
    });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["ok"]);
    const servedWhileAllowed = served;

    // Revoke the allowance. The client stays "connected"; the next request
    // must still be refused.
    delete process.env[MCP_TARGET_ALLOW_ENV];
    await expect(client.listTools()).rejects.toBeInstanceOf(McpTargetBlockedError);
    expect(served).toBe(servedWhileAllowed);

    await client.close().catch(() => {});
  }, 20_000);

  test("a same-origin redirect still works, so legitimate servers are not broken", async () => {
    // Guarding must not mean "no redirects at all" — a path canonicalization
    // on the SAME allowed origin has to keep working.
    let served = 0;
    const vendor = track(
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/mcp") {
            // Relative Location, resolved against the current URL.
            return new Response(null, { status: 307, headers: { location: "/mcp/v1" } });
          }
          served++;
          const body = (await req.json().catch(() => ({}))) as { method?: string; id?: unknown };
          if (body.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "vendor", version: "1.0.0" },
              },
            });
          }
          if (body.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools: [{ name: "ok", description: "d", inputSchema: { type: "object" } }] },
            });
          }
          return new Response(null, { status: 202 });
        },
      }),
    );
    process.env[MCP_TARGET_ALLOW_ENV] = "127.0.0.1";

    const client = new McpClient({
      transport: "http",
      name: "vendor",
      url: `http://127.0.0.1:${vendor.port}/mcp`,
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
    expect(served).toBeGreaterThan(0);
    await client.close().catch(() => {});
  }, 20_000);
});

// ── Unit cover for the wrapper itself ────────────────────────────────

/** A fetch stub driven by a scripted list of responses, recording calls. */
function scriptedFetch(steps: Array<Response | ((url: string, init: RequestInit) => Response)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.href;
    calls.push({ url, init: init ?? {} });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return typeof step === "function" ? step(url, init ?? {}) : step!;
  };
  return { impl, calls };
}

function redirectTo(location: string, status = 307): Response {
  return new Response(null, { status, headers: { location } });
}

/** Guard deps that allow every PUBLIC address and nothing private, with no
 *  real DNS: hostnames map through a fixed table. */
const publicResolver = async (host: string): Promise<string[]> => {
  const table: Record<string, string[]> = {
    "vendor.test": ["93.184.216.34"],
    "other.test": ["93.184.216.35"],
    "internal.test": ["10.0.0.5"],
  };
  return table[host] ?? [];
};

describe("createMcpGuardedFetch", () => {
  test("passes a non-redirect response straight through", async () => {
    const { impl, calls } = scriptedFetch([Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const res = await f("http://vendor.test/mcp");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    // The guard forces manual redirect handling on every hop.
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  test("validates the FIRST request too, not just redirects", async () => {
    const { impl, calls } = scriptedFetch([Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await expect(f("http://internal.test/mcp")).rejects.toBeInstanceOf(McpTargetBlockedError);
    // Never reached the transport.
    expect(calls).toHaveLength(0);
  });

  test("refuses a redirect hop onto a private address", async () => {
    const { impl, calls } = scriptedFetch([
      redirectTo("http://internal.test/latest/"),
      Response.json({ leaked: true }),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await expect(f("http://vendor.test/mcp")).rejects.toBeInstanceOf(McpTargetBlockedError);
    // Only the first (allowed) request happened; the hop was never dialed.
    expect(calls).toHaveLength(1);
  });

  test("resolves a relative Location against the current URL", async () => {
    const { impl, calls } = scriptedFetch([
      redirectTo("/mcp/v1"),
      Response.json({ ok: true }),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const res = await f("http://vendor.test/mcp");
    expect(res.status).toBe(200);
    expect(calls[1]!.url).toBe("http://vendor.test/mcp/v1");
  });

  test("a relative Location cannot escape to a private host", async () => {
    // `//internal.test/x` is protocol-relative — it CHANGES host despite
    // looking like a path.
    const { impl } = scriptedFetch([redirectTo("//internal.test/x"), Response.json({})]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await expect(f("http://vendor.test/mcp")).rejects.toBeInstanceOf(McpTargetBlockedError);
  });

  test("refuses a cross-scheme hop", async () => {
    const { impl } = scriptedFetch([redirectTo("file:///etc/passwd"), Response.json({})]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const err = await f("http://vendor.test/mcp").catch((e) => e);
    expect(err).toBeInstanceOf(McpTargetBlockedError);
    expect((err as McpTargetBlockedError).reason).toBe("scheme");
  });

  test("caps the redirect chain", async () => {
    // Always redirects, same allowed origin — only the hop cap can stop it.
    const { impl, calls } = scriptedFetch([
      (url) => redirectTo(`${url}/x`),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const err = await f("http://vendor.test/mcp").catch((e) => e);
    expect(err).toBeInstanceOf(McpTargetBlockedError);
    expect((err as McpTargetBlockedError).reason).toBe("redirect-limit");
    // MCP_MAX_REDIRECTS hops followed, plus the original request.
    expect(calls).toHaveLength(MCP_MAX_REDIRECTS + 1);
  });

  test("refuses an unparseable Location without echoing it", async () => {
    const { impl } = scriptedFetch([
      new Response(null, { status: 307, headers: { location: "http://[::bad::]/" } }),
      Response.json({}),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const err = await f("http://vendor.test/mcp").catch((e) => e);
    expect(err).toBeInstanceOf(McpTargetBlockedError);
    expect((err as McpTargetBlockedError).target).not.toContain("bad");
  });

  test("a 3xx without a Location header is treated as terminal", async () => {
    const { impl, calls } = scriptedFetch([new Response("body", { status: 304 })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const res = await f("http://vendor.test/mcp");
    expect(res.status).toBe(304);
    expect(calls).toHaveLength(1);
  });

  test("302 downgrades the method to GET and drops the body", async () => {
    const { impl, calls } = scriptedFetch([redirectTo("/next", 302), Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await f("http://vendor.test/mcp", { method: "POST", body: '{"jsonrpc":"2.0"}' });
    expect(calls[1]!.init.method).toBe("GET");
    expect(calls[1]!.init.body).toBeUndefined();
  });

  test("307 preserves the method and body", async () => {
    const { impl, calls } = scriptedFetch([redirectTo("/next", 307), Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await f("http://vendor.test/mcp", { method: "POST", body: '{"jsonrpc":"2.0"}' });
    expect(calls[1]!.init.method).toBe("POST");
    expect(calls[1]!.init.body).toBe('{"jsonrpc":"2.0"}');
  });

  test("a HEAD request is not downgraded on 302", async () => {
    const { impl, calls } = scriptedFetch([redirectTo("/next", 302), Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await f("http://vendor.test/mcp", { method: "HEAD" });
    expect(calls[1]!.init.method).toBe("HEAD");
  });

  test("credentials are stripped when the hop crosses origin", async () => {
    // A vendor must not be able to harvest its own bearer token by
    // redirecting us to a host it controls.
    const { impl, calls } = scriptedFetch([
      redirectTo("http://other.test/mcp"),
      Response.json({ ok: true }),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await f("http://vendor.test/mcp", {
      headers: { authorization: "Bearer SECRET", cookie: "s=1", "x-keep": "yes" },
    });
    const sent = new Headers(calls[1]!.init.headers);
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("cookie")).toBeNull();
    // Non-credential headers survive.
    expect(sent.get("x-keep")).toBe("yes");
  });

  test("credentials survive a same-origin hop", async () => {
    const { impl, calls } = scriptedFetch([redirectTo("/v2"), Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await f("http://vendor.test/mcp", { headers: { authorization: "Bearer SECRET" } });
    const sent = new Headers(calls[1]!.init.headers);
    expect(sent.get("authorization")).toBe("Bearer SECRET");
  });

  test("the terminal body is returned UNREAD so an SSE stream keeps streaming", async () => {
    // Reading the body here is what would hang a live MCP event stream, so
    // the wrapper must hand it back untouched.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: hello\n\n"));
        c.close();
      },
    });
    const { impl } = scriptedFetch([
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const res = await f("http://vendor.test/mcp");
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("data: hello\n\n");
  });

  test("a redirect body that cannot be drained is not fatal", async () => {
    const failing = new ReadableStream({
      pull(c) {
        c.error(new Error("stream broke"));
      },
    });
    const { impl } = scriptedFetch([
      new Response(failing, { status: 307, headers: { location: "/next" } }),
      Response.json({ ok: true }),
    ]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    const res = await f("http://vendor.test/mcp");
    expect(res.status).toBe(200);
  });

  test("accepts both shapes the SDK's FetchLike may pass", async () => {
    // `FetchLike` is `(url: string | URL, init?) => Promise<Response>` — the
    // SDK never passes a `Request`, so neither does the wrapper's contract.
    const { impl, calls } = scriptedFetch([Response.json({ ok: true })]);
    const f = createMcpGuardedFetch({ fetchImpl: impl, resolveHost: publicResolver, allowRaw: "" });
    await f(new URL("http://vendor.test/a"));
    await f("http://vendor.test/b");
    expect(calls.map((c) => c.url)).toEqual(["http://vendor.test/a", "http://vendor.test/b"]);
  });

  test("defaults to the global fetch when none is injected", async () => {
    // Exercised against a real local server so no network egress happens.
    let hit = 0;
    const srv = track(
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          hit++;
          return Response.json({ ok: true });
        },
      }),
    );
    const f = createMcpGuardedFetch({ allowRaw: "127.0.0.1" });
    const res = await f(`http://127.0.0.1:${srv.port}/`);
    expect(res.status).toBe(200);
    expect(hit).toBe(1);
  });
});
