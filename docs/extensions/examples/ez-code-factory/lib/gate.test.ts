import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repoId,
  dataDir,
  reposDir,
  gateDir,
  credentialPath,
  notifyLogPath,
  hookScript,
  isManagedHook,
  isSafeUpstreamUrl,
  decideRemoteWiring,
  initGate,
  HOOK_MARKER,
  GATE_REMOTE,
  EXTENSION_NAME,
  DEFAULT_BASE_URL,
} from "./gate";
import { productionHostRunner, type ShellRunner, type ShellResult } from "./shell";

// ── temp-repo scaffolding (real git; test context is un-sandboxed) ──

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ezcf-gate-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => productionHostRunner(["git", ...args], cwd);

/** A bare upstream + a working clone with one commit on `feat/x`. `base` lets a
 *  single test stand up several isolated repos (default: the per-test `root`).
 *  `workName` may carry a space to exercise path-with-space handling. */
async function makeWorkRepo(
  withOrigin = true,
  base = root,
  workName = "work",
): Promise<{ work: string; upstream: string }> {
  const upstream = join(base, "upstream.git");
  await git(["init", "--bare", upstream], base);
  const work = join(base, workName);
  mkdirSync(work);
  await git(["init", "-b", "main"], work);
  await git(["config", "user.email", "t@t"], work);
  await git(["config", "user.name", "t"], work);
  writeFileSync(join(work, "README.md"), "hi\n");
  await git(["add", "-A"], work);
  await git(["commit", "-m", "init"], work);
  await git(["checkout", "-b", "feat/x"], work);
  writeFileSync(join(work, "f.txt"), "change\n");
  await git(["add", "-A"], work);
  await git(["commit", "-m", "feat"], work);
  if (withOrigin) await git(["remote", "add", "origin", upstream], work);
  return { work, upstream };
}

/** A live mock events route returning `status`; records every POST. A body that
 *  is not valid JSON is recorded as the sentinel string so a test can prove the
 *  hook produced parseable JSON. */
function mockEventsServer(status = 200): {
  server: ReturnType<typeof Bun.serve>;
  received: Array<{ auth: string | null; body: unknown }>;
} {
  const received: Array<{ auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = "__invalid_json__";
      }
      received.push({ auth: req.headers.get("authorization"), body });
      return new Response(JSON.stringify({ ok: status < 400 }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, received };
}

// ── pure helpers ────────────────────────────────────────────────────

describe("repoId", () => {
  test("is a deterministic 12-hex prefix of sha256(path)", () => {
    const a = repoId("/abs/project");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(repoId("/abs/project")).toBe(a);
    expect(repoId("/other")).not.toBe(a);
  });
});

describe("path helpers", () => {
  test("compose the data-dir convention path", () => {
    const p = "/proj";
    expect(dataDir(p)).toBe(`/proj/.ezcorp/extension-data/${EXTENSION_NAME}`);
    expect(reposDir(p)).toBe(`/proj/.ezcorp/extension-data/${EXTENSION_NAME}/repos`);
    expect(gateDir(p, "abc123def456")).toBe(
      `/proj/.ezcorp/extension-data/${EXTENSION_NAME}/repos/abc123def456.git`,
    );
    expect(credentialPath(p)).toBe(`/proj/.ezcorp/extension-data/${EXTENSION_NAME}/gate-key`);
    expect(notifyLogPath("/g.git")).toBe("/g.git/notify-push.log");
  });
});

describe("hookScript", () => {
  const script = hookScript({
    repoId: "abc123def456",
    projectRoot: "/proj/it's here",
    baseUrl: "http://h:1/",
    credentialPath: "/cred/gate-key",
    notifyLogPath: "/g.git/notify-push.log",
  });
  test("carries the managed marker + always exits 0", () => {
    expect(isManagedHook(script)).toBe(true);
    expect(script).toContain(HOOK_MARKER);
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });
  test("targets the extension-events route + reads the key from the credential FILE", () => {
    expect(script).toContain(`/api/extensions/${EXTENSION_NAME}/events/push-received`);
    expect(script).toContain("CRED_FILE='/cred/gate-key'");
    // The key is read at push time, never inlined.
    expect(script).toContain('KEY=$(cat "$CRED_FILE"');
    // The POST body is well-formed JSON with the hub-source discriminator.
    expect(script).toContain('\\"source\\":\\"hub\\"');
  });
  test("bakes the project root into the payload (shell-quoted + json-escaped)", () => {
    // shQuote wraps in single quotes and escapes the embedded quote.
    expect(script).toContain(`PROJECT_ROOT='/proj/it'\\''s here'`);
    // The payload carries the json_escape'd root so the context-free
    // push-received handler can resolve the project (repoId-hash validated).
    expect(script).toContain('esc_root=$(json_escape "$PROJECT_ROOT")');
    expect(script).toContain('\\"projectRoot\\":\\"$esc_root\\"');
  });
  test("emits valid POSIX sh", async () => {
    const f = join(root, "hook.sh");
    writeFileSync(f, script);
    const res = await productionHostRunner(["sh", "-n", f], root);
    expect(res.exitCode).toBe(0);
  });
});

describe("isManagedHook", () => {
  test("false for a foreign hook", () => {
    expect(isManagedHook("#!/bin/sh\necho hi\n")).toBe(false);
  });
});

describe("isSafeUpstreamUrl", () => {
  test("accepts https / ssh / scp-like URLs", () => {
    expect(isSafeUpstreamUrl("https://example.com/x.git")).toBe(true);
    expect(isSafeUpstreamUrl("ssh://git@host:22/me/x.git")).toBe(true);
    expect(isSafeUpstreamUrl("git@github.com:me/x.git")).toBe(true);
    expect(isSafeUpstreamUrl("  https://example.com/x.git  ")).toBe(true); // trimmed
  });
  test("rejects command-executing transports, local paths, flags, empties", () => {
    expect(isSafeUpstreamUrl("ext::sh -c 'touch /tmp/pwn'")).toBe(false);
    expect(isSafeUpstreamUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUpstreamUrl("/srv/git/x.git")).toBe(false); // bare local path
    expect(isSafeUpstreamUrl("--upload-pack=touch /tmp/pwn")).toBe(false);
    expect(isSafeUpstreamUrl("-oProxyCommand=evil")).toBe(false);
    expect(isSafeUpstreamUrl("")).toBe(false);
    expect(isSafeUpstreamUrl("   ")).toBe(false);
    expect(isSafeUpstreamUrl("http ://bad")).toBe(false); // whitespace in URL
  });
});

describe("decideRemoteWiring", () => {
  const repos = "/proj/.ezcorp/extension-data/ez-code-factory/repos";
  const gate = `${repos}/abc.git`;
  test("add when no remote exists", () => {
    expect(decideRemoteWiring(null, gate, repos)).toBe("add");
    expect(decideRemoteWiring("", gate, repos)).toBe("add");
  });
  test("noop when already our exact gate dir (idempotent)", () => {
    expect(decideRemoteWiring(gate, gate, repos)).toBe("noop");
    expect(decideRemoteWiring(`file://${gate}`, gate, repos)).toBe("noop");
  });
  test("repoint when a sibling under our reposDir (stale gate id)", () => {
    expect(decideRemoteWiring(`${repos}/OLD.git`, gate, repos)).toBe("repoint");
  });
  test("refuse a foreign URL", () => {
    expect(decideRemoteWiring("git@github.com:me/x.git", gate, repos)).toBe("refuse");
    expect(decideRemoteWiring("/somewhere/else.git", gate, repos)).toBe("refuse");
  });
});

// ── initGate integration (real git) ─────────────────────────────────

describe("initGate (real git)", () => {
  test("fresh provision: bare repo, managed hook, gate remote, gate origin", async () => {
    const { work, upstream } = await makeWorkRepo();
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res.ok).toBe(true);
    expect(res.bareCreated).toBe(true);
    expect(res.hookAction).toBe("written");
    expect(res.remoteAction).toBe("add");

    // Bare repo + managed hook on disk.
    const gDir = gateDir(work, res.repoId);
    expect(existsSync(gDir)).toBe(true);
    const hookPath = join(gDir, "hooks", "post-receive");
    expect(isManagedHook(readFileSync(hookPath, "utf8"))).toBe(true);

    // Working repo now has a `gate` remote → the gate dir.
    const remote = await git(["remote", "get-url", GATE_REMOTE], work);
    expect(remote.stdout.trim()).toBe(gDir);
    // Gate repo's origin mirrors the working repo's upstream.
    const gateOrigin = await git(["remote", "get-url", "origin"], gDir);
    expect(gateOrigin.stdout.trim()).toBe(upstream);
    // Push-option advertisement is on.
    const adv = await git(["config", "receive.advertisePushOptions"], gDir);
    expect(adv.stdout.trim()).toBe("true");
  });

  test("idempotent re-init: bareCreated false, hook refreshed, remote noop", async () => {
    const { work } = await makeWorkRepo();
    await initGate({ projectRoot: work, run: productionHostRunner });
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res.ok).toBe(true);
    expect(res.bareCreated).toBe(false);
    expect(res.hookAction).toBe("refreshed");
    expect(res.remoteAction).toBe("noop");
  });

  test("explicit upstream overrides the working repo's origin", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({
      projectRoot: work,
      run: productionHostRunner,
      upstream: "https://example.com/custom.git",
    });
    const gateOrigin = await git(["remote", "get-url", "origin"], gateDir(work, res.repoId));
    expect(gateOrigin.stdout.trim()).toBe("https://example.com/custom.git");
  });

  test("no upstream: gate origin left unset with a warning", async () => {
    const { work } = await makeWorkRepo(false); // no origin on the working repo
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("no upstream"))).toBe(true);
    const gateOrigin = await git(["remote", "get-url", "origin"], gateDir(work, res.repoId));
    expect(gateOrigin.exitCode).not.toBe(0); // origin never added
  });

  test("ignores an UNSAFE explicit upstream (never falls back to origin)", async () => {
    const { work } = await makeWorkRepo(); // has a benign origin
    const res = await initGate({
      projectRoot: work,
      run: productionHostRunner,
      upstream: "ext::sh -c 'touch /tmp/pwn'", // command-executing transport
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("unsafe upstream"))).toBe(true);
    // Fail-closed: the unsafe URL is refused AND the trusted origin is NOT
    // silently substituted — the gate repo gets no origin at all.
    const gateOrigin = await git(["remote", "get-url", "origin"], gateDir(work, res.repoId));
    expect(gateOrigin.exitCode).not.toBe(0);
  });

  test("best-effort chmod 0600 on a pre-existing lax-mode gate credential", async () => {
    const { work } = await makeWorkRepo();
    // Drop a world-readable credential BEFORE init.
    const cred = credentialPath(work);
    mkdirSync(dataDir(work), { recursive: true });
    writeFileSync(cred, "minted-key");
    chmodSync(cred, 0o644);
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res.ok).toBe(true);
    expect(statSync(cred).mode & 0o777).toBe(0o600);
  });

  test("credential chmod failure → best-effort warning (init still ok)", async () => {
    const { work } = await makeWorkRepo();
    mkdirSync(dataDir(work), { recursive: true });
    writeFileSync(credentialPath(work), "k"); // exists → `test -f` passes, chmod runs
    const res = await initGate({ projectRoot: work, run: failingAt(/^chmod 0600/) });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("credential mode"))).toBe(true);
  });

  test("refuses to clobber a foreign `gate` remote", async () => {
    const { work } = await makeWorkRepo();
    await git(["remote", "add", GATE_REMOTE, "git@github.com:foreign/x.git"], work);
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res.ok).toBe(true);
    expect(res.remoteAction).toBe("refuse");
    expect(res.warnings.some((w) => w.includes("foreign URL"))).toBe(true);
    // The foreign URL is untouched.
    const remote = await git(["remote", "get-url", GATE_REMOTE], work);
    expect(remote.stdout.trim()).toBe("git@github.com:foreign/x.git");
  });

  test("repoints a stale gate remote (sibling under our reposDir)", async () => {
    const { work } = await makeWorkRepo();
    const stale = join(reposDir(work), "STALE.git");
    await git(["remote", "add", GATE_REMOTE, stale], work);
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res.remoteAction).toBe("repoint");
    const remote = await git(["remote", "get-url", GATE_REMOTE], work);
    expect(remote.stdout.trim()).toBe(gateDir(work, res.repoId));
  });

  test("leaves a foreign post-receive hook untouched", async () => {
    const { work } = await makeWorkRepo();
    const res1 = await initGate({ projectRoot: work, run: productionHostRunner });
    const hookPath = join(gateDir(work, res1.repoId), "hooks", "post-receive");
    writeFileSync(hookPath, "#!/bin/sh\necho custom\n");
    const res2 = await initGate({ projectRoot: work, run: productionHostRunner });
    expect(res2.hookAction).toBe("skipped-foreign");
    expect(readFileSync(hookPath, "utf8")).toBe("#!/bin/sh\necho custom\n");
    expect(res2.warnings.some((w) => w.includes("not ours"))).toBe(true);
  });
});

// ── init failure branches (scripted runner) ─────────────────────────

/** A runner that fails only for commands whose joined form matches `failOn`,
 *  delegating everything else to real git so the flow reaches the failure. */
function failingAt(failOn: RegExp, stderr = "boom"): ShellRunner {
  return async (cmd, cwd, opts) => {
    if (failOn.test(cmd.join(" "))) {
      return { exitCode: 1, stdout: "", stderr } satisfies ShellResult;
    }
    return productionHostRunner(cmd, cwd, opts);
  };
}

describe("initGate failure branches", () => {
  test("git init --bare failure → error result", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({ projectRoot: work, run: failingAt(/git init --bare/) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("git init --bare failed");
  });

  test("advertisePushOptions failure → error result", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({
      projectRoot: work,
      run: failingAt(/config receive\.advertisePushOptions/),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("advertisePushOptions");
  });

  test("worktreeConfig failure → warning (best-effort)", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({
      projectRoot: work,
      run: failingAt(/config extensions\.worktreeConfig/),
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("worktreeConfig"))).toBe(true);
  });

  test("gate-origin set failure → warning", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({
      projectRoot: work,
      run: failingAt(/remote (?:add|set-url) --end-of-options origin/),
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.includes("gate origin"))).toBe(true);
  });

  test("hook write failure → error result", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({ projectRoot: work, run: failingAt(/^sh -c mkdir -p/) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("post-receive hook");
  });

  test("gate-remote wiring failure → error result", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({
      projectRoot: work,
      run: failingAt(new RegExp(`remote add ${GATE_REMOTE}`)),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`'${GATE_REMOTE}' remote`);
  });

  test("uses DEFAULT_BASE_URL when none is provided", async () => {
    const { work } = await makeWorkRepo();
    const res = await initGate({ projectRoot: work, run: productionHostRunner });
    const hook = readFileSync(join(gateDir(work, res.repoId), "hooks", "post-receive"), "utf8");
    expect(hook).toContain(DEFAULT_BASE_URL);
  });
});

// ── real push → hook → trigger (the M0 headline) ────────────────────

describe("git push gate → post-receive hook fires the trigger", () => {
  test("push succeeds (exit 0) and the hook POSTs the correct payload", async () => {
    const { work } = await makeWorkRepo();
    // A live mock server captures the hook's trigger POST.
    const received: Array<{ auth: string | null; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({ auth: req.headers.get("authorization"), body: await req.json() });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const res = await initGate({
        projectRoot: work,
        run: productionHostRunner,
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      writeFileSync(credentialPath(work), "minted-key-xyz");

      const push = await git(["push", GATE_REMOTE, "feat/x"], work);
      expect(push.exitCode).toBe(0); // a gate never blocks a push

      // The hook delivered the push metadata to the events route.
      await Bun.sleep(50);
      expect(received).toHaveLength(1);
      expect(received[0]!.auth).toBe("Bearer minted-key-xyz");
      const body = received[0]!.body as { source: string; pageId: string; payload: Record<string, unknown> };
      expect(body.source).toBe("hub");
      expect(body.pageId).toBe("dashboard");
      expect(body.payload.repoId).toBe(res.repoId);
      expect(body.payload.branch).toBe("feat/x");
      expect(body.payload.ref).toBe("refs/heads/feat/x");
      expect(typeof body.payload.newSha).toBe("string");
      expect((body.payload.newSha as string).length).toBeGreaterThanOrEqual(40);
      expect(body.payload.pushOptions).toEqual([]); // no -o given
    } finally {
      server.stop(true);
    }
  });

  test("an HTTP >=400 response is logged + echoed to stderr; push still exits 0", async () => {
    for (const status of [401, 503]) {
      const sub = mkdtempSync(join(root, `http-${status}-`));
      const { work } = await makeWorkRepo(true, sub);
      const { server, received } = mockEventsServer(status);
      try {
        const res = await initGate({
          projectRoot: work,
          run: productionHostRunner,
          baseUrl: `http://127.0.0.1:${server.port}`,
        });
        writeFileSync(credentialPath(work), "k");

        const push = await git(["push", GATE_REMOTE, "feat/x"], work);
        expect(push.exitCode).toBe(0); // a gate never blocks a push, even on 4xx/5xx
        await Bun.sleep(50);
        expect(received).toHaveLength(1); // the POST DID reach the server

        const log = readFileSync(notifyLogPath(gateDir(work, res.repoId)), "utf8");
        expect(log).toContain(`HTTP ${status}`);
        // The banner reaches the pusher's stderr too (not just the log).
        expect(push.stderr).toContain("ez-code-factory: trigger POST failed");
      } finally {
        server.stop(true);
      }
    }
  });

  test("forwards --push-option values as a JSON array", async () => {
    const { work } = await makeWorkRepo();
    const { server, received } = mockEventsServer(200);
    try {
      await initGate({
        projectRoot: work,
        run: productionHostRunner,
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      writeFileSync(credentialPath(work), "k");

      const push = await git(["push", "-o", "intent=fix", "-o", "x=y", GATE_REMOTE, "feat/x"], work);
      expect(push.exitCode).toBe(0);
      await Bun.sleep(50);
      const body = received[0]!.body as { payload: { pushOptions: unknown } };
      expect(body.payload.pushOptions).toEqual(["intent=fix", "x=y"]);
    } finally {
      server.stop(true);
    }
  });

  test("JSON-escapes a ref/branch containing a double quote (valid JSON received)", async () => {
    const { work } = await makeWorkRepo();
    await git(["branch", 'a"b'], work); // git permits a double quote in a ref name
    const { server, received } = mockEventsServer(200);
    try {
      await initGate({
        projectRoot: work,
        run: productionHostRunner,
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      writeFileSync(credentialPath(work), "k");

      const push = await git(["push", GATE_REMOTE, 'a"b'], work);
      expect(push.exitCode).toBe(0);
      await Bun.sleep(50);
      expect(received).toHaveLength(1);
      // A parsed object (not the "__invalid_json__" sentinel) proves the quote
      // did not break the hand-built body; the ref survives verbatim.
      const body = received[0]!.body as { payload: { ref: string; branch: string } };
      expect(body.payload.ref).toBe('refs/heads/a"b');
      expect(body.payload.branch).toBe('a"b');
    } finally {
      server.stop(true);
    }
  });

  test("skips a branch deletion and a tag push (no run-creating POST)", async () => {
    const { work } = await makeWorkRepo();
    const { server, received } = mockEventsServer(200);
    try {
      await initGate({
        projectRoot: work,
        run: productionHostRunner,
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      writeFileSync(credentialPath(work), "k");

      // The create posts once…
      await git(["push", GATE_REMOTE, "feat/x"], work);
      await Bun.sleep(50);
      expect(received).toHaveLength(1);
      received.length = 0;

      // …but a deletion (all-zero newrev) and a tag push must both be skipped.
      const del = await git(["push", GATE_REMOTE, ":feat/x"], work);
      expect(del.exitCode).toBe(0);
      await git(["tag", "v1"], work);
      const tagPush = await git(["push", GATE_REMOTE, "v1"], work);
      expect(tagPush.exitCode).toBe(0);
      await Bun.sleep(50);
      expect(received).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("provisions + pushes through a project root containing a space", async () => {
    const { work } = await makeWorkRepo(true, root, "a project"); // path has a space
    const { server, received } = mockEventsServer(200);
    try {
      const res = await initGate({
        projectRoot: work,
        run: productionHostRunner,
        baseUrl: `http://127.0.0.1:${server.port}`,
      });
      expect(res.ok).toBe(true);
      writeFileSync(credentialPath(work), "k");

      const push = await git(["push", GATE_REMOTE, "feat/x"], work);
      expect(push.exitCode).toBe(0);
      await Bun.sleep(50);
      expect(received).toHaveLength(1);
      const body = received[0]!.body as { payload: { branch: string } };
      expect(body.payload.branch).toBe("feat/x");
    } finally {
      server.stop(true);
    }
  });

  test("trigger failure is logged to notify-push.log and the push still exits 0", async () => {
    const { work } = await makeWorkRepo();
    // Bind + immediately release a port so it is guaranteed closed (curl fails
    // fast with connection-refused rather than hitting any live server).
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = probe.port;
    probe.stop(true);

    const res = await initGate({
      projectRoot: work,
      run: productionHostRunner,
      baseUrl: `http://127.0.0.1:${deadPort}`,
    });
    writeFileSync(credentialPath(work), "minted-key-xyz");

    const push = await git(["push", GATE_REMOTE, "feat/x"], work);
    expect(push.exitCode).toBe(0);

    const log = readFileSync(notifyLogPath(gateDir(work, res.repoId)), "utf8");
    expect(log).toContain("trigger POST failed");
    // The one-line banner also reaches the pusher's stderr.
    expect(push.stderr).toContain("ez-code-factory: trigger POST failed");
  });
});
