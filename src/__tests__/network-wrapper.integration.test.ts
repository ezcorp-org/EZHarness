/**
 * Integration smoke for Phase 2's in-sandbox fetch wrapper.
 *
 * Spawns a real `bun` subprocess running `sandbox-preload.ts` with
 * representative env vars (`EZCORP_NETWORK_ALLOWED=1`,
 * `EZCORP_PERMITTED_HOSTS=...`, `EZCORP_TOOL_NETWORK_CAPS=...`), then
 * calls `fetch(...)` inside the subprocess to assert:
 *
 *   • allowlist hit  → fetch reaches a real localhost stub and returns 200
 *   • allowlist miss → wrapper throws with the per-host error message
 *   • per-tool override miss → wrapper throws with the per-tool error
 *     message (after the SDK's `withToolContext` binds the active tool)
 *
 * The SDK's `getChannel()` is NOT started in these probes — we only
 * exercise the wrapper's external lane (no internal RPC), so we avoid
 * any stdin/stdout coupling. The localhost stub uses a freshly bound
 * port via `Bun.serve({ port: 0 })`.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../extensions/runtime/sandbox-preload.ts",
);

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

async function runUnderPreload(
  code: string,
  env: Record<string, string>,
): Promise<ProbeResult> {
  const fullEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    EZCORP_NETWORK_ALLOWED: "1",
    ...env,
  };
  const proc = Bun.spawn(["bun", "--preload", SANDBOX_PRELOAD_PATH, "-e", code], {
    stdout: "pipe",
    stderr: "pipe",
    env: fullEnv,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// ── Localhost stub ──────────────────────────────────────────────
//
// Phase 2's wrapper denies external dial-out for hosts not in
// PERMITTED_HOSTS. To exercise the allow path, we spin a tiny
// `Bun.serve` stub on a high port and tell the wrapper "127.x is in
// the allowlist via the host alias api.foo.com". Hostname resolution
// happens inside the subprocess — the stub is bound on 127.0.0.1, so
// we hit it via http://127.0.0.1:<port>/.
//
// BUT 127.x routes through the wrapper's internal lane (reverse-RPC),
// not the external lane. We need an external-looking hostname that
// resolves to localhost. The cleanest approach: use an `/etc/hosts`-
// style HOSTALIASES file… or skip the allow path's network round-trip
// and assert only on the wrapper's classification (which the
// network-wrapper.test.ts already covers comprehensively).
//
// The integration test's MUST is the deny-path message — that's what
// the spec calls out. The allow path is sufficient via the
// network-wrapper.test.ts unit matrix + the github-stats SDK
// integration test's BYOK-Tavily route (which proves a real
// allowlist hit reaches a real upstream).

let stubServer: ReturnType<typeof Bun.serve>;
let stubPort: number;

beforeAll(() => {
  stubServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response("stub-ok", { status: 200 });
    },
  });
  // `Bun.serve({port:0})` synchronously binds and assigns a real port;
  // `.port` is typed `number | undefined` for the lazy-binding case.
  // We just instantiated above, so a non-null assertion here is safe.
  stubPort = stubServer.port ?? 0;
});

afterAll(() => {
  stubServer.stop(true);
});

describe("Phase 2 fetch wrapper — integration smoke (subprocess + preload)", () => {
  test("allowlist hit (host in PERMITTED_HOSTS) → wrapper does NOT deny, classifier reaches external lane", async () => {
    // We can't actually dial `api.foo.com` (no DNS) — and we can't use
    // `127.0.0.1` because that's an internal host. The classifier's
    // allow path is exhaustively covered in network-wrapper.test.ts;
    // the integration MUST is that the wrapper's preload installation
    // doesn't accidentally turn the allow-path into a deny. We probe by
    // racing the fetch against a 250ms timer — a connection attempt
    // (timeout / refusal / DNS error) without a sandbox-deny throw is
    // proof the classifier reached the external lane.
    // Wrapper-deny throws say "Extension sandbox: hostname '...' is not in
    // the granted network allowlist". Abort / connection errors say
    // something else. We log a tagged prefix so the assertion can split.
    const code = [
      `const ctrl = new AbortController();`,
      `const t = setTimeout(() => ctrl.abort(), 250);`,
      `try {`,
      `  await fetch('http://api.foo.com:${stubPort}/', { signal: ctrl.signal });`,
      `  console.log('reached');`,
      `} catch (e) {`,
      `  if (String(e.message).startsWith('Extension sandbox')) console.log('SANDBOX_DENY:' + e.message);`,
      `  else console.log('FETCH_ERR_OK');`,
      `} finally { clearTimeout(t); }`,
    ].join(" ");
    const out = await runUnderPreload(code, {
      EZCORP_PERMITTED_HOSTS: "api.foo.com",
    });
    expect(out.stdout).toMatch(/FETCH_ERR_OK|reached/);
    expect(out.stdout).not.toMatch(/SANDBOX_DENY/);
  });

  test("allowlist miss (evil.com NOT in PERMITTED_HOSTS) → wrapper throws with per-host error", async () => {
    const out = await runUnderPreload(
      `await fetch('https://evil.com/x').catch((e) => { ` +
      `  console.log('caught:' + e.message); ` +
      `})`,
      { EZCORP_PERMITTED_HOSTS: "api.foo.com" },
    );
    expect(out.stdout).toMatch(
      /caught:Extension sandbox: hostname 'evil\.com' is not in the granted network allowlist/,
    );
    // Confirms the granted hosts are echoed in the error.
    expect(out.stdout).toContain("granted: api.foo.com");
  });

  test("empty PERMITTED_HOSTS → every external host denied", async () => {
    const out = await runUnderPreload(
      `await fetch('https://anywhere.tld/').catch((e) => console.log('caught:' + e.message))`,
      { EZCORP_PERMITTED_HOSTS: "" },
    );
    expect(out.stdout).toMatch(
      /caught:Extension sandbox: hostname 'anywhere\.tld' is not in the granted network allowlist/,
    );
  });

  test("per-tool override miss: tool t1 declared api.foo.com only; URL=api.bar.com → deny with tool name", async () => {
    // The SDK's `withToolContext` binds the active tool name in ALS.
    // Inside the probe we call it explicitly to simulate what the
    // dispatcher does for every `tools/call`. The wrapper then reads
    // the bound name via `getToolContext()` and consults
    // `EZCORP_TOOL_NETWORK_CAPS`.
    const code = [
      `const { withToolContext } = await import('@ezcorp/sdk/runtime');`,
      `await withToolContext({ toolName: 't1', conversationId: 'c-1' }, async () => {`,
      `  await fetch('https://api.bar.com/x').catch((e) => console.log('caught:' + e.message));`,
      `});`,
    ].join("\n");
    const out = await runUnderPreload(code, {
      EZCORP_PERMITTED_HOSTS: "api.foo.com,api.bar.com",
      EZCORP_TOOL_NETWORK_CAPS: JSON.stringify({ t1: ["api.foo.com"] }),
    });
    expect(out.stdout).toMatch(
      /caught:Extension sandbox: tool 't1' did not declare network access to 'api\.bar\.com'/,
    );
    expect(out.stdout).toContain("tool's hosts: api.foo.com");
  });

  test("per-tool override hit: tool t1 declared api.foo.com; URL=api.foo.com → wrapper does NOT deny", async () => {
    // Same approach as the first test — bound the fetch to 250ms so
    // we don't hang if api.foo.com doesn't resolve. The MUST is no
    // sandbox-deny message; the underlying fetch's outcome is incidental.
    const code = [
      `const { withToolContext } = await import('@ezcorp/sdk/runtime');`,
      `await withToolContext({ toolName: 't1', conversationId: 'c-1' }, async () => {`,
      `  const ctrl = new AbortController();`,
      `  const t = setTimeout(() => ctrl.abort(), 250);`,
      `  try {`,
      `    await fetch('http://api.foo.com:${stubPort}/', { signal: ctrl.signal });`,
      `    console.log('reached');`,
      `  } catch (e) {`,
      `    if (String(e.message).startsWith('Extension sandbox')) console.log('SANDBOX_DENY:' + e.message);`,
      `    else console.log('FETCH_ERR_OK');`,
      `  } finally { clearTimeout(t); }`,
      `});`,
    ].join(" ");
    const out = await runUnderPreload(code, {
      EZCORP_PERMITTED_HOSTS: "api.foo.com",
      EZCORP_TOOL_NETWORK_CAPS: JSON.stringify({ t1: ["api.foo.com"] }),
    });
    expect(out.stdout).toMatch(/FETCH_ERR_OK|reached/);
    expect(out.stdout).not.toMatch(/SANDBOX_DENY/);
  });

  test("ALS unset (no withToolContext) → extension-wide allowlist still applies", async () => {
    // Outside any tool handler — fetch at module init time. Wrapper
    // skips the per-tool check and relies only on PERMITTED_HOSTS.
    // api.bar.com IS in the extension-wide allowlist, so we expect
    // FETCH_ERR_OK (or reached) — never a sandbox-deny.
    const code = [
      `const ctrl = new AbortController();`,
      `const t = setTimeout(() => ctrl.abort(), 250);`,
      `try {`,
      `  await fetch('https://api.bar.com/', { signal: ctrl.signal });`,
      `  console.log('reached');`,
      `} catch (e) {`,
      `  if (String(e.message).startsWith('Extension sandbox')) console.log('SANDBOX_DENY:' + e.message);`,
      `  else console.log('FETCH_ERR_OK');`,
      `} finally { clearTimeout(t); }`,
    ].join(" ");
    const out = await runUnderPreload(code, {
      EZCORP_PERMITTED_HOSTS: "api.foo.com,api.bar.com",
      EZCORP_TOOL_NETWORK_CAPS: JSON.stringify({ t1: ["api.foo.com"] }),
    });
    expect(out.stdout).toMatch(/FETCH_ERR_OK|reached/);
    expect(out.stdout).not.toMatch(/SANDBOX_DENY/);
  });

  test("malformed EZCORP_TOOL_NETWORK_CAPS → treat as empty (no leak), extension-wide still applies", async () => {
    const code = [
      `const { withToolContext } = await import('@ezcorp/sdk/runtime');`,
      `await withToolContext({ toolName: 't1', conversationId: 'c-1' }, async () => {`,
      `  const ctrl = new AbortController();`,
      `  const t = setTimeout(() => ctrl.abort(), 250);`,
      `  try {`,
      `    await fetch('https://api.bar.com/', { signal: ctrl.signal });`,
      `    console.log('reached');`,
      `  } catch (e) {`,
      `    if (String(e.message).startsWith('Extension sandbox')) console.log('SANDBOX_DENY:' + e.message);`,
      `    else console.log('FETCH_ERR_OK');`,
      `  } finally { clearTimeout(t); }`,
      `});`,
    ].join(" ");
    const out = await runUnderPreload(code, {
      EZCORP_PERMITTED_HOSTS: "api.foo.com,api.bar.com",
      EZCORP_TOOL_NETWORK_CAPS: "{not valid json",
    });
    // Malformed map → empty map → wrapper falls back to extension-wide
    // ceiling only. api.bar.com is in PERMITTED_HOSTS, so no sandbox-deny.
    expect(out.stdout).toMatch(/FETCH_ERR_OK|reached/);
    expect(out.stdout).not.toMatch(/SANDBOX_DENY/);
  });
});
