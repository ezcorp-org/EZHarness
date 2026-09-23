import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives `deploy/installer/ezcorp` — the core every OS installer package wraps
 * — against stub engine/compose/curl binaries, and holds the compose files it
 * layers against the contracts they depend on.
 *
 * ## What these protect
 *
 * The installer runs unattended in front of someone who cannot read a compose
 * error, so its failure modes are silent-and-destructive rather than loud:
 *
 *  - **Re-keying.** The three secrets live in `.env`. The data is encrypted
 *    with them. Anything that deletes one while keeping the other turns a
 *    reinstall into a fresh install with orphaned data — no error, every
 *    stored provider key undecryptable. This is the property the uninstall
 *    tests exist for; the non-purge path was doing exactly this when the
 *    lifecycle was first run by hand.
 *  - **Port coupling.** The image pins EZCORP_PORT=3000 and in-container
 *    loopback callers (web/src/lib/server/security/bundled-creds.ts) depend on
 *    it, while ORIGIN must track the HOST port or svelte-adapter-bun defaults
 *    the scheme to https and login breaks. Setting the wrong one of those two
 *    is invisible until a user tries to log in.
 *  - **A dead suggestion host.** With the ollama profile off there is no such
 *    service, so EZCORP_SUGGEST_OLLAMA_URL must be absent rather than
 *    pointing at a host that will never answer.
 *
 * ## Why this is not a tautology
 *
 * The script assertions run the REAL script and inspect the files it writes
 * and the argv it hands the engine, rather than grepping it for strings. The
 * compose assertions hold that file against the invariants stated elsewhere
 * in the repo (the image's fixed internal port, compose.prod.yml's build/guard
 * shape) instead of restating its own contents.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "deploy", "installer", "ezcorp");
const COMPOSE_INSTALLER = join(REPO_ROOT, "deploy", "installer", "compose.installer.yml");

const SANDBOX = mkdtempSync(join(tmpdir(), "ezcorp-installer-"));
const BIN = join(SANDBOX, "bin");
mkdirSync(BIN, { recursive: true });

function stub(name: string, body: string): void {
  const path = join(BIN, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// Engine stub: claims a running VM, reports the image as already present (so
// the pull leg is skipped), and logs every invocation.
stub(
  "podman",
  [
    'echo "podman $*" >> "$EZCORP_TEST_LOG"',
    'case "$1 $2" in',
    '  "machine inspect") echo "running"; exit 0 ;;',
    '  "image exists") exit 0 ;;',
    "esac",
    "exit 0",
  ].join("\n"),
);
stub("docker-compose", ['echo "compose $*" >> "$EZCORP_TEST_LOG"', "exit 0"].join("\n"));
// The readiness probe is what gates "open the browser"; always ready here.
stub("curl", ['echo "curl $*" >> "$EZCORP_TEST_LOG"', 'echo \'{"state":"ready","since":"now"}\'', "exit 0"].join("\n"));
// Keep the real install from opening a browser window on the test machine.
stub("open", ['echo "open $*" >> "$EZCORP_TEST_LOG"', "exit 0"].join("\n"));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
}

let caseDir: string;
let configDir: string;
let dataRoot: string;

beforeEach(() => {
  caseDir = mkdtempSync(join(SANDBOX, "case-"));
  configDir = join(caseDir, "config");
  dataRoot = join(caseDir, "data");
});

function run(args: string[], extraEnv: Record<string, string> = {}, stdin = ""): Run {
  const logPath = join(caseDir, "invocations.log");
  const proc = Bun.spawnSync({
    cmd: ["bash", SCRIPT, ...args],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      EZCORP_CONFIG_DIR: configDir,
      EZCORP_DATA_ROOT: dataRoot,
      EZCORP_CONTAINER_ENGINE: "podman",
      EZCORP_IMAGE: "ezcorp:test",
      EZCORP_TEST_LOG: logPath,
      ...extraEnv,
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

function envFile(): string {
  return readFileSync(join(configDir, ".env"), "utf8");
}

describe("ezcorp install — the config it generates", () => {
  test("writes every secret the stack needs, readable only by the owner", () => {
    const result = run(["install"]);
    expect(result.exitCode).toBe(0);

    const env = envFile();
    for (const key of [
      "EZCORP_ENCRYPTION_SECRET",
      "EZCORP_ENCRYPTION_SALT",
      "EZCORP_JWT_SECRET",
      "SEARXNG_SECRET",
    ]) {
      expect(env, `${key} missing`).toContain(`${key}=`);
      // A present-but-empty assignment would satisfy a substring check and
      // fail at boot, so require actual material.
      const value = env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
      expect(value.length, `${key} is empty`).toBeGreaterThan(16);
    }

    expect(statSync(join(configDir, ".env")).mode & 0o777).toBe(0o600);
  });

  test("points ORIGIN at the host port but never overrides the container's port", () => {
    run(["install"]);
    const env = envFile();

    const port = env.match(/^EZCORP_PORT_HOST=(\d+)$/m)?.[1];
    expect(port).toBeDefined();
    expect(env).toContain(`EZCORP_PUBLIC_URL=http://localhost:${port}`);

    // EZCORP_PORT is the CONTAINER's port, pinned to 3000 by the image.
    // Setting it from the host side breaks in-container loopback callers.
    expect(env).not.toMatch(/^EZCORP_PORT=/m);
  });

  test("creates all four bind-mount sources before starting the stack", () => {
    run(["install"]);
    for (const dir of ["data", "extensions", "extension-data", "projects"]) {
      expect(existsSync(join(dataRoot, dir)), `${dir} not created`).toBe(true);
    }
  });

  test("layers the rootless keep-id overlay", () => {
    const result = run(["install"]);
    // Without it the uid-1000 runtime cannot write the bind mount and PGlite
    // fails to open on first boot.
    expect(result.log).toContain("compose.machine.yml");
  });

  test("skips the download when the image is already on the machine", () => {
    const result = run(["install"]);
    expect(result.log).not.toMatch(/compose .*\bpull\b/);
    expect(result.stdout).toContain("already on this machine");
  });

  test("leaves the suggestion model off, and its URL unset with it", () => {
    run(["install"]);
    // A set URL with the profile off means the composer dials a host that
    // does not exist on every keystroke.
    expect(envFile()).not.toContain("EZCORP_SUGGEST_OLLAMA_URL");
    expect(run(["status"]).stdout).toContain("suggestions: off");
  });
});

describe("ezcorp install — port selection", () => {
  test("moves to the next port when the preferred one is taken", async () => {
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 4000, socket: { data() {} } });
    try {
      const result = run(["install"]);
      expect(result.exitCode).toBe(0);
      const port = Number(envFile().match(/^EZCORP_PORT_HOST=(\d+)$/m)?.[1]);
      expect(port).toBeGreaterThan(4000);
      expect(result.stdout).toContain("was busy");
    } finally {
      blocker.stop(true);
    }
  });

  test("a second install resumes instead of re-keying", () => {
    run(["install"]);
    const first = envFile();
    const again = run(["install"]);

    expect(again.stdout).toContain("already set up");
    // Re-running the installer must never mint new secrets: the data on disk
    // is encrypted with the old ones.
    expect(envFile()).toBe(first);
  });
});

describe("ezcorp uninstall — what it may and may not destroy", () => {
  test("keeps the data AND the key that data is encrypted with", () => {
    run(["install"]);
    const secretBefore = envFile().match(/^EZCORP_ENCRYPTION_SECRET=(.*)$/m)?.[1];
    mkdirSync(join(dataRoot, "data", "ezcorp"), { recursive: true });

    const result = run(["uninstall"]);
    expect(result.exitCode).toBe(0);

    expect(existsSync(join(dataRoot, "data", "ezcorp"))).toBe(true);
    expect(envFile().match(/^EZCORP_ENCRYPTION_SECRET=(.*)$/m)?.[1]).toBe(secretBefore);
  });

  test("--purge deletes nothing unless the confirmation is typed exactly", () => {
    run(["install"]);
    mkdirSync(join(dataRoot, "data", "ezcorp"), { recursive: true });

    const refused = run(["uninstall", "--purge"], {}, "yes\n");
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(join(dataRoot, "data", "ezcorp"))).toBe(true);

    const confirmed = run(["uninstall", "--purge"], {}, "DELETE\n");
    expect(confirmed.exitCode).toBe(0);
    expect(existsSync(dataRoot)).toBe(false);
  });
});

describe("compose.installer.yml — the contracts it must honor", () => {
  test("pulls a released image and never builds on the user's machine", async () => {
    const text = await Bun.file(COMPOSE_INSTALLER).text();
    expect(text).not.toMatch(/^\s*build:/m);
    expect(text).toMatch(/\$\{EZCORP_IMAGE\}/);
  });

  test("carries no fail-fast interpolation guards, because the installer writes every value", async () => {
    // Comment lines are stripped first: the header explains the fail-fast
    // interpolation convention it declines to use, and prose is not config.
    const yaml = (await Bun.file(COMPOSE_INSTALLER).text())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // compose.prod.yml aborts on a missing secret, which is right for a
    // hand-edited .env.prod. Here it would surface a compose stack trace to
    // someone who has never opened a terminal; the installer validates first.
    expect(yaml).not.toMatch(/\$\{[A-Z_]+:\?/);
  });

  test("maps the host port onto the container port the image actually pins", async () => {
    const compose = await Bun.file(COMPOSE_INSTALLER).text();
    const dockerfile = await Bun.file(join(REPO_ROOT, "Dockerfile")).text();

    const pinned = dockerfile.match(/^ENV EZCORP_PORT=(\d+)/m)?.[1];
    expect(pinned).toBeDefined();
    expect(compose).toContain(`"\${EZCORP_PORT_HOST}:${pinned}"`);
    expect(compose).toContain(`EZCORP_PORT: "${pinned}"`);
  });

  test("keeps the suggestion sidecars behind an opt-in profile", async () => {
    const text = await Bun.file(COMPOSE_INSTALLER).text();
    const ollamaBlock = text.slice(text.indexOf("\n  ollama:"));
    expect(ollamaBlock).toContain('profiles: ["suggest"]');
  });

  test("pins the data and secrets paths into the mounted volume", async () => {
    const text = await Bun.file(COMPOSE_INSTALLER).text();
    // Left unset, getSecretsDir() falls back to process.cwd() — /app inside
    // the image, which is image state and vanishes on the next pull.
    expect(text).toContain("EZCORP_DB_PATH: /app/data/ezcorp");
    expect(text).toContain("EZCORP_SECRETS_DIR: /app/data");
  });
});
