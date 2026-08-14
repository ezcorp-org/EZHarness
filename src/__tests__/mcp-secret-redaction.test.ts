/**
 * Unit tests for the ONE MCP credential classifier
 * (`src/extensions/mcp-secret-redaction.ts`, issue #205).
 *
 * Pure module, no DB — so this file asserts the RULES exhaustively and the
 * integration suites (`mcp-url-argv-secrets.test.ts`,
 * `mcp-secrets-*.test.ts`) assert that the persistence, read, connect and
 * migration paths actually use them.
 *
 * Three properties are load bearing and each has its own group below:
 *
 *   • IDENTITY on no-change — `mcpServerHasPlaintextSecret` is defined as
 *     `redactMcpServer(s) !== s`, so a redactor that returned a fresh object
 *     for a clean row would make the boot backfill re-migrate forever.
 *   • HOSTS SURVIVE — `mcpNetworkHosts` derives the `network` ceiling from the
 *     REDACTED definition; blanking a host would shrink a live grant.
 *   • REHYDRATION IS GUARDED — a stored blob is applied only when redacting it
 *     reproduces what is at rest, so a stale blob cannot dial a stale host.
 */
import { test, expect, describe } from "bun:test";
import {
  MCP_SECRET_BLOB_VERSION,
  applyMcpSecretBlob,
  buildMcpSecretBlob,
  isSecretFlagName,
  mcpServerHasPlaintextSecret,
  mergeMcpServerSecrets,
  parseMcpSecretBlob,
  redactExtensionSecrets,
  redactMcpArgv,
  redactMcpServer,
  redactUrlPassword,
  redactUrlQueryValues,
  redactUrlSecrets,
  redactUrlSecretsInToken,
  serializeMcpSecretBlob,
} from "../extensions/mcp-secret-redaction";
import { mcpNetworkHosts } from "../extensions/mcp-capabilities";
import type { McpServerDefinition, McpServerHttp, McpServerStdio } from "../extensions/types";

describe("redactUrlQueryValues", () => {
  test("blanks every value and keeps every name", () => {
    expect(redactUrlQueryValues("https://h/mcp?api_key=SECRET")).toBe("https://h/mcp?api_key=");
    expect(redactUrlQueryValues("https://h/mcp?a=1&b=2&c=3")).toBe("https://h/mcp?a=&b=&c=");
  });

  test("no query string → the SAME string back", () => {
    const url = "https://h/mcp";
    expect(redactUrlQueryValues(url)).toBe(url);
  });

  test("an empty query, a valueless param and an already-blank param are identity", () => {
    expect(redactUrlQueryValues("https://h/mcp?")).toBe("https://h/mcp?");
    expect(redactUrlQueryValues("https://h/mcp?flag")).toBe("https://h/mcp?flag");
    expect(redactUrlQueryValues("https://h/mcp?k=")).toBe("https://h/mcp?k=");
    expect(redactUrlQueryValues("https://h/mcp?flag&k=")).toBe("https://h/mcp?flag&k=");
  });

  test("the fragment is preserved byte-for-byte and never scanned as a param", () => {
    expect(redactUrlQueryValues("https://h/mcp?k=S#frag=notaparam")).toBe(
      "https://h/mcp?k=#frag=notaparam",
    );
  });

  test("a nameless param (`=v`) still loses its value", () => {
    expect(redactUrlQueryValues("https://h/mcp?=S")).toBe("https://h/mcp?=");
  });

  test("no URL normalisation — the operator's bytes survive", () => {
    // `new URL(x).toString()` would append a "/" path and lower-case the host.
    const url = "https://Host.EXAMPLE.com?k=S";
    expect(redactUrlQueryValues(url)).toBe("https://Host.EXAMPLE.com?k=");
  });
});

describe("redactUrlPassword", () => {
  test("drops the password, keeps the username", () => {
    expect(redactUrlPassword("https://svc:pw@h/mcp")).toBe("https://svc:@h/mcp");
  });

  test("identity when there is no userinfo, no colon, or a blank password", () => {
    expect(redactUrlPassword("https://h/mcp")).toBe("https://h/mcp");
    expect(redactUrlPassword("https://svc@h/mcp")).toBe("https://svc@h/mcp");
    expect(redactUrlPassword("https://svc:@h/mcp")).toBe("https://svc:@h/mcp");
  });

  test("an `@` in the path or query is not userinfo", () => {
    expect(redactUrlPassword("https://h/mcp/a@b")).toBe("https://h/mcp/a@b");
    expect(redactUrlPassword("https://h/mcp?to=a@b")).toBe("https://h/mcp?to=a@b");
  });

  test("both rules compose", () => {
    expect(redactUrlSecrets("https://svc:pw@h/mcp?api_key=S")).toBe("https://svc:@h/mcp?api_key=");
  });
});

describe("redactUrlSecretsInToken", () => {
  test("a token with no URL is identity", () => {
    expect(redactUrlSecretsInToken("--verbose")).toBe("--verbose");
    expect(redactUrlSecretsInToken("npx")).toBe("npx");
  });

  test("a flag-attached URL keeps the flag and the host", () => {
    expect(redactUrlSecretsInToken("--endpoint=https://h/mcp?k=S")).toBe(
      "--endpoint=https://h/mcp?k=",
    );
  });

  test("a clean URL inside a token is identity", () => {
    expect(redactUrlSecretsInToken("--endpoint=https://h/mcp")).toBe("--endpoint=https://h/mcp");
  });
});

describe("isSecretFlagName", () => {
  test("credential words match in any dash/underscore/dot position", () => {
    for (const flag of [
      "--token", "--api-key", "--api_key", "--apikey", "--gh-pat", "--auth-header",
      "--client-secret", "--password", "-p.pwd", "--session", "--cookie", "--header",
      "--bearer", "--jwt", "--dsn", "--signature", "--sig", "--access-token", "--creds",
      "--supabase-service-role-key",
    ]) {
      expect(isSecretFlagName(flag)).toBe(true);
    }
  });

  test("innocuous flags that CONTAIN a credential word as a substring do NOT match", () => {
    // The exact-word rule is the whole point: a substring test would blank the
    // value of `--path` (pat), `--pattern` (pat) and `--author` (auth), and a
    // blanked path breaks the command it belongs to.
    for (const flag of ["--path", "--pattern", "--author", "--patch", "--passthrough", "--verbose"]) {
      expect(isSecretFlagName(flag)).toBe(false);
    }
  });

  test("a bare dash run is not a flag name", () => {
    expect(isSecretFlagName("--")).toBe(false);
  });
});

describe("redactMcpArgv", () => {
  test("`--token=VALUE` keeps the flag and loses the value", () => {
    expect(redactMcpArgv(["-y", "srv", "--token=SECRET"])).toEqual(["-y", "srv", "--token="]);
  });

  test("an env-assignment token (`docker run -e NAME=VALUE`) loses its value too", () => {
    expect(redactMcpArgv(["run", "-i", "--rm", "-e", "GITHUB_TOKEN=ghp_x", "mcp/github"])).toEqual([
      "run", "-i", "--rm", "-e", "GITHUB_TOKEN=", "mcp/github",
    ]);
  });

  test("the space-separated pair form is blanked only after a credential-named flag", () => {
    expect(redactMcpArgv(["--token", "SECRET"])).toEqual(["--token", ""]);
    // `-y` is not a credential name, so the package it introduces survives.
    expect(redactMcpArgv(["-y", "@modelcontextprotocol/server-github"])).toEqual([
      "-y", "@modelcontextprotocol/server-github",
    ]);
  });

  test("a credential flag followed by another FLAG has no value to hide", () => {
    expect(redactMcpArgv(["--token", "--verbose"])).toEqual(["--token", "--verbose"]);
  });

  test("a URL keeps its host and path, losing only the query values", () => {
    expect(redactMcpArgv(["mcp-remote", "https://mcp.example.com/mcp?api_key=S"])).toEqual([
      "mcp-remote", "https://mcp.example.com/mcp?api_key=",
    ]);
  });

  test("a URL after a credential-named flag is query-redacted, NOT blanked", () => {
    // Blanking it whole would delete the host `mcpNetworkHosts` derives the
    // grant from, and the connect would then be denied.
    expect(redactMcpArgv(["--auth-url", "https://idp.example.com/t?client_secret=S"])).toEqual([
      "--auth-url", "https://idp.example.com/t?client_secret=",
    ]);
  });

  test("returns the SAME array reference when nothing is redactable", () => {
    const args = ["-y", "@scope/pkg", "--verbose"];
    expect(redactMcpArgv(args)).toBe(args);
  });

  test("an already-redacted argv is identity (idempotent)", () => {
    const once = redactMcpArgv(["-y", "srv", "--token=S", "--api-key", "K"]);
    expect(redactMcpArgv(once)).toBe(once);
  });

  test("STATED RESIDUAL: a bare positional secret is NOT redacted", () => {
    // Documented in the module header, pinned here so the claim cannot rot into
    // an unnoticed regression in either direction.
    expect(redactMcpArgv(["srv", "MY-BARE-SECRET"])).toEqual(["srv", "MY-BARE-SECRET"]);
  });
});

describe("redactMcpServer", () => {
  test("http: url query + password + header values all go; names stay", () => {
    const redacted = redactMcpServer({
      transport: "http",
      name: "s",
      url: "https://svc:pw@h/mcp?api_key=S&t=2",
      headers: { Authorization: "Bearer B" },
    }) as McpServerHttp;
    expect(redacted.url).toBe("https://svc:@h/mcp?api_key=&t=");
    expect(redacted.headers).toEqual({ Authorization: "" });
  });

  test("stdio: command URL, argv and env are all covered", () => {
    const redacted = redactMcpServer({
      transport: "stdio",
      name: "s",
      command: "https://h/run?k=S",
      args: ["--token=T"],
      env: { API_KEY: "k" },
    }) as McpServerStdio;
    expect(redacted.command).toBe("https://h/run?k=");
    expect(redacted.args).toEqual(["--token="]);
    expect(redacted.env).toEqual({ API_KEY: "" });
  });

  test("returns the SAME reference when there is nothing to redact", () => {
    const stdio: McpServerDefinition = { transport: "stdio", name: "s", command: "node" };
    expect(redactMcpServer(stdio)).toBe(stdio);
    const http: McpServerDefinition = { transport: "http", name: "s", url: "https://h/mcp" };
    expect(redactMcpServer(http)).toBe(http);
    // An ALREADY-redacted definition too — this is the backfill's idempotency.
    const blanked: McpServerDefinition = {
      transport: "stdio",
      name: "s",
      command: "npx",
      args: ["-y", "srv", "--token="],
      env: { API_KEY: "" },
    };
    expect(redactMcpServer(blanked)).toBe(blanked);
    const blankedHttp: McpServerDefinition = {
      transport: "http",
      name: "s",
      url: "https://h/mcp?k=",
      headers: { Authorization: "" },
    };
    expect(redactMcpServer(blankedHttp)).toBe(blankedHttp);
  });

  test("an empty env/headers map is identity", () => {
    const stdio: McpServerDefinition = { transport: "stdio", name: "s", command: "node", env: {} };
    expect(redactMcpServer(stdio)).toBe(stdio);
    const http: McpServerDefinition = { transport: "sse", name: "s", url: "https://h/sse", headers: {} };
    expect(redactMcpServer(http)).toBe(http);
  });

  test("mcpServerHasPlaintextSecret agrees with the redactor, by construction", () => {
    expect(mcpServerHasPlaintextSecret({ transport: "stdio", name: "s", command: "node" })).toBe(false);
    expect(
      mcpServerHasPlaintextSecret({
        transport: "http",
        name: "s",
        url: "https://h/mcp?api_key=S",
      }),
    ).toBe(true);
  });

  test("HOSTS SURVIVE redaction — the network ceiling is unchanged", () => {
    const stdio: McpServerDefinition = {
      transport: "stdio",
      name: "s",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.example.com/mcp?api_key=S", "--token=T"],
    };
    expect(mcpNetworkHosts(redactMcpServer(stdio))).toEqual(mcpNetworkHosts(stdio));
    expect(mcpNetworkHosts(redactMcpServer(stdio))).toEqual(["mcp.example.com"]);
    const http: McpServerDefinition = {
      transport: "http",
      name: "s",
      url: "https://api.vendor.com/mcp?api_key=S",
    };
    expect(mcpNetworkHosts(redactMcpServer(http))).toEqual(["api.vendor.com"]);
  });
});

describe("redactExtensionSecrets", () => {
  test("scrubs an MCP row's url query and argv", () => {
    const row = {
      id: "x",
      manifest: {
        kind: "mcp",
        name: "legacy",
        mcpServers: [
          { transport: "http", name: "legacy", url: "https://h/mcp?api_key=LEAK" },
          { transport: "stdio", name: "legacy2", command: "npx", args: ["--token=LEAK2"] },
        ],
        tools: [],
        permissions: {},
      },
    };
    const redacted = redactExtensionSecrets(row);
    expect(JSON.stringify(redacted)).not.toContain("LEAK");
    const servers = (redacted.manifest as { mcpServers: McpServerDefinition[] }).mcpServers;
    expect((servers[0] as McpServerHttp).url).toBe("https://h/mcp?api_key=");
    expect((servers[1] as McpServerStdio).args).toEqual(["--token="]);
  });

  test("non-MCP, manifest-less and server-less rows pass through by reference", () => {
    const local = { id: "x", manifest: { kind: "local", name: "l", tools: [], permissions: {} } };
    expect(redactExtensionSecrets(local)).toBe(local);
    const none = { id: "x", manifest: null };
    expect(redactExtensionSecrets(none)).toBe(none);
    const empty = { id: "x", manifest: { kind: "mcp", name: "m", mcpServers: [] } };
    expect(redactExtensionSecrets(empty)).toBe(empty);
  });
});

describe("secret blob", () => {
  test("http: the real url and header map are stored verbatim under one envelope", () => {
    const blob = buildMcpSecretBlob({
      transport: "http",
      name: "s",
      url: "https://h/mcp?api_key=S",
      headers: { Authorization: "Bearer B" },
    });
    expect(blob).toEqual({ auth: { Authorization: "Bearer B" }, url: "https://h/mcp?api_key=S" });
    expect(JSON.parse(serializeMcpSecretBlob(blob!))).toEqual({
      v: MCP_SECRET_BLOB_VERSION,
      auth: { Authorization: "Bearer B" },
      url: "https://h/mcp?api_key=S",
    });
  });

  test("stdio: env, command and args are each stored only when redaction touched them", () => {
    expect(
      buildMcpSecretBlob({
        transport: "stdio",
        name: "s",
        command: "npx",
        args: ["--token=T"],
        env: { K: "v" },
      }),
    ).toEqual({ auth: { K: "v" }, args: ["--token=T"] });
    expect(
      buildMcpSecretBlob({ transport: "stdio", name: "s", command: "https://h/x?k=S" }),
    ).toEqual({ command: "https://h/x?k=S" });
  });

  test("a definition with no credential produces NO blob (so no secret row)", () => {
    expect(buildMcpSecretBlob({ transport: "stdio", name: "s", command: "node" })).toBeNull();
    // Blank-valued maps are not credentials either.
    expect(
      buildMcpSecretBlob({ transport: "http", name: "s", url: "https://h/mcp", headers: { A: "" } }),
    ).toBeNull();
  });

  test("parse accepts the v2 envelope", () => {
    expect(
      parseMcpSecretBlob(
        JSON.stringify({ v: 2, auth: { A: "b" }, url: "u", command: "c", args: ["a"] }),
      ),
    ).toEqual({ auth: { A: "b" }, url: "u", command: "c", args: ["a"] });
  });

  test("parse accepts a PRE-#205 bare auth map (every row written before this change)", () => {
    expect(parseMcpSecretBlob(JSON.stringify({ Authorization: "Bearer OLD" }))).toEqual({
      auth: { Authorization: "Bearer OLD" },
    });
  });

  test("parse drops wrong-typed envelope fields rather than trusting them", () => {
    expect(
      parseMcpSecretBlob(JSON.stringify({ v: 2, auth: { n: 1 }, url: 5, command: [], args: [1] })),
    ).toEqual({});
  });

  test("parse rejects non-JSON, non-objects, arrays and non-string maps", () => {
    expect(parseMcpSecretBlob("not-json{")).toBeNull();
    expect(parseMcpSecretBlob("null")).toBeNull();
    expect(parseMcpSecretBlob("[1,2]")).toBeNull();
    expect(parseMcpSecretBlob(JSON.stringify({ a: 1 }))).toBeNull();
  });
});

describe("applyMcpSecretBlob (rehydration guard)", () => {
  test("http: url and headers are restored", () => {
    const out = applyMcpSecretBlob(
      { transport: "http", name: "s", url: "https://h/mcp?k=", headers: { A: "", B: "" } },
      { auth: { A: "real" }, url: "https://h/mcp?k=SECRET" },
    ) as McpServerHttp;
    expect(out.url).toBe("https://h/mcp?k=SECRET");
    // A key present only in the manifest survives as a blank; a stored key wins.
    expect(out.headers).toEqual({ A: "real", B: "" });
  });

  test("stdio: env, command and args are restored", () => {
    const out = applyMcpSecretBlob(
      { transport: "stdio", name: "s", command: "https://h/x?k=", args: ["--token="] },
      { auth: { E: "v" }, command: "https://h/x?k=S", args: ["--token=T"] },
    ) as McpServerStdio;
    expect(out.command).toBe("https://h/x?k=S");
    expect(out.args).toEqual(["--token=T"]);
    expect(out.env).toEqual({ E: "v" });
  });

  test("a STALE blob is refused: the at-rest (blanked) value wins", () => {
    // The admin re-pointed the server; a leftover blob for the OLD host must
    // never be dialled, and a leftover argv must never be pasted into a
    // different command line.
    const http = applyMcpSecretBlob(
      { transport: "http", name: "s", url: "https://new.example/mcp?k=" },
      { url: "https://old.example/mcp?k=STALE" },
    ) as McpServerHttp;
    expect(http.url).toBe("https://new.example/mcp?k=");
    const stdio = applyMcpSecretBlob(
      { transport: "stdio", name: "s", command: "npx", args: ["-y", "other", "--token="] },
      { args: ["-y", "srv", "--token=STALE"], command: "https://h/x?k=STALE" },
    ) as McpServerStdio;
    expect(stdio.args).toEqual(["-y", "other", "--token="]);
    expect(stdio.command).toBe("npx");
  });

  test("an empty blob leaves the definition alone", () => {
    const server: McpServerDefinition = { transport: "sse", name: "s", url: "https://h/sse" };
    expect(applyMcpSecretBlob(server, {})).toEqual(server);
    const stdio: McpServerDefinition = { transport: "stdio", name: "s", command: "node" };
    expect(applyMcpSecretBlob(stdio, {})).toEqual(stdio);
  });

  test("round-trip: redact → build → apply reproduces the original", () => {
    for (const server of [
      {
        transport: "http" as const,
        name: "s",
        url: "https://svc:pw@h/mcp?api_key=S&t=2",
        headers: { Authorization: "Bearer B" },
      },
      {
        transport: "stdio" as const,
        name: "s",
        command: "npx",
        args: ["-y", "srv", "--token=T", "--api-key", "K", "https://h/m?q=Z"],
        env: { E: "v" },
      },
    ]) {
      const blob = buildMcpSecretBlob(server);
      expect(blob).not.toBeNull();
      expect(applyMcpSecretBlob(redactMcpServer(server), blob!)).toEqual(server);
    }
  });
});

describe("mergeMcpServerSecrets (edit form: blank means keep)", () => {
  const prevHttp: McpServerDefinition = {
    transport: "http",
    name: "s",
    url: "https://svc:pw@h/mcp?api_key=REAL&t=9",
    headers: { Authorization: "Bearer REAL", Accept: "application/json" },
  };

  test("a submitted blank query value / password / header keeps the previous secret", () => {
    const merged = mergeMcpServerSecrets(
      {
        transport: "http",
        name: "s",
        url: "https://svc:@h/mcp?api_key=&t=",
        headers: { Authorization: "" },
      },
      prevHttp,
    ) as McpServerHttp;
    expect(merged.url).toBe("https://svc:pw@h/mcp?api_key=REAL&t=9");
    expect(merged.headers).toEqual({ Authorization: "Bearer REAL", Accept: "application/json" });
  });

  test("a retyped value REPLACES; an unknown blank param stays blank", () => {
    const merged = mergeMcpServerSecrets(
      {
        transport: "http",
        name: "s",
        url: "https://h/mcp?api_key=&brand-new=",
        headers: { Authorization: "Bearer FRESH" },
      },
      prevHttp,
    ) as McpServerHttp;
    expect(merged.url).toBe("https://h/mcp?api_key=REAL&brand-new=");
    expect(merged.headers?.Authorization).toBe("Bearer FRESH");
  });

  test("a re-pointed host does not inherit the old password", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "http", name: "s", url: "https://other:@h2/mcp" },
      prevHttp,
    ) as McpServerHttp;
    expect(merged.url).toBe("https://other:@h2/mcp");
  });

  test("no previous definition at all → the submitted values stand", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "http", name: "s", url: "https://h/mcp?k=" },
      undefined,
    ) as McpServerHttp;
    expect(merged.url).toBe("https://h/mcp?k=");
    expect(merged.headers).toEqual({});
  });

  test("a transport SWITCH does not carry credentials across", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "http", name: "s", url: "https://h/mcp?k=" },
      { transport: "stdio", name: "s", command: "npx", args: ["--token=OLD"] },
    ) as McpServerHttp;
    expect(merged.url).toBe("https://h/mcp?k=");
    expect(merged.headers).toEqual({});
  });

  const prevStdio: McpServerDefinition = {
    transport: "stdio",
    name: "s",
    command: "npx",
    args: ["-y", "srv", "--token=REAL", "--api-key", "REALKEY", "https://h/m?q=REALQ"],
    env: { API_KEY: "REALENV" },
  };

  test("an UNEDITED prefill round-trips WHOLE, even though the join drops the blank slot", () => {
    // This is the real edit-form cycle for a description-only or header-only
    // edit: prefill from the blanked manifest → space-join → post back. The
    // pair-form `""` vanishes in the join, so per-name matching alone would
    // slide the URL operand into `--api-key`'s slot and lose REALKEY.
    const merged = mergeMcpServerSecrets(
      {
        transport: "stdio",
        name: "s",
        command: "npx",
        args: ["-y", "srv", "--token=", "--api-key", "https://h/m?q="],
      },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.args).toEqual([
      "-y", "srv", "--token=REAL", "--api-key", "REALKEY", "https://h/m?q=REALQ",
    ]);
    // The form never sends stdio `env`, so it must be preserved, not wiped.
    expect(merged.env).toEqual({ API_KEY: "REALENV" });
  });

  test("a GENUINELY edited argv still refills every blank it can match by name", () => {
    const merged = mergeMcpServerSecrets(
      {
        transport: "stdio",
        name: "s",
        command: "npx",
        args: ["-y", "srv", "--token=", "--verbose", "https://h/m?q="],
      },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.args).toEqual(["-y", "srv", "--token=REAL", "--verbose", "https://h/m?q=REALQ"]);
  });

  test("no previous argv at all → the submitted argv stands", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", args: ["--token="] },
      { transport: "stdio", name: "s", command: "npx" },
    ) as McpServerStdio;
    expect(merged.args).toEqual(["--token="]);
  });

  test("stdio: a credential flag left LAST, or followed by a flag, still refills", () => {
    const trailing = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", args: ["-y", "srv", "--api-key"] },
      prevStdio,
    ) as McpServerStdio;
    expect(trailing.args).toEqual(["-y", "srv", "--api-key", "REALKEY"]);
    const beforeFlag = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", args: ["--api-key", "--verbose"] },
      prevStdio,
    ) as McpServerStdio;
    expect(beforeFlag.args).toEqual(["--api-key", "REALKEY", "--verbose"]);
  });

  test("stdio: an EMPTY pair-form token is refilled and consumed exactly once", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", args: ["--api-key", "", "--verbose"] },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.args).toEqual(["--api-key", "REALKEY", "--verbose"]);
  });

  test("stdio: a retyped argv value REPLACES the stored one", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", args: ["--token=FRESH", "--api-key", "FRESHKEY"] },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.args).toEqual(["--token=FRESH", "--api-key", "FRESHKEY"]);
  });

  test("stdio: an unknown blank flag and a non-credential flag are left alone", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", args: ["--brand-new=", "-y", "pkg"] },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.args).toEqual(["--brand-new=", "-y", "pkg"]);
  });

  test("stdio: a command URL's blank param refills, and a plain command is untouched", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "https://h/m?q=" },
      { transport: "stdio", name: "s", command: "https://h/m?q=CMDQ", args: ["https://h/m?q=CMDQ"] },
    ) as McpServerStdio;
    expect(merged.command).toBe("https://h/m?q=CMDQ");
    const plain = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "node" },
      prevStdio,
    ) as McpServerStdio;
    expect(plain.command).toBe("node");
    expect(plain.args).toBeUndefined();
  });

  test("stdio: a submitted env value overrides the previous one", () => {
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: "npx", env: { API_KEY: "TYPED", OTHER: "  " } },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.env).toEqual({ API_KEY: "TYPED" });
  });

  test("the merged definition survives a redact→merge round trip unchanged", () => {
    // This is the edit form's real cycle: store blanked → prefill → post back
    // → merge. It must reproduce the live definition byte-for-byte, or a
    // description-only edit silently drops the credential.
    const redacted = redactMcpServer(prevStdio) as McpServerStdio;
    const merged = mergeMcpServerSecrets(
      { transport: "stdio", name: "s", command: redacted.command, args: redacted.args },
      prevStdio,
    ) as McpServerStdio;
    expect(merged.args).toEqual((prevStdio as McpServerStdio).args);
  });
});
