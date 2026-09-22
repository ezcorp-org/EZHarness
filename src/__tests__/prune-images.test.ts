import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Holds `scripts/prune-images.sh` — which reclaims the ~4.5 GB image every
 * prod rebuild leaves dangling — to the one property that makes it safe to run
 * automatically: it only ever removes DANGLING images carrying THIS project's
 * OCI title label.
 *
 * ## The bugs these exist to prevent
 *
 * 1. Unbounded disk growth: each `up --build` orphans the previous image and
 *    nothing removes it. Measured twice on a 60 GB `podman machine` — the
 *    build then dies at the `chown -R /app` layer commit with "no space left
 *    on device".
 * 2. The fix over-reaching: a bare `image prune` would delete every other
 *    project's dangling images on the same engine. The filter is the safety
 *    property, so it is asserted on the exact argv the engine receives.
 *
 * ## Why this is not a tautology
 *
 * The real script runs under /bin/bash against a stub engine that records its
 * argv; the label value is read from the Dockerfile rather than restated here.
 */

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "prune-images.sh");
const SANDBOX = mkdtempSync(join(tmpdir(), "prune-images-"));
const CALLS = join(SANDBOX, "calls.log");
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

writeFileSync(
  join(SANDBOX, "podman"),
  `#!/bin/sh\necho "$*" >> "${CALLS}"\n[ "$1" = "images" ] && printf '%s' "$STUB_IMAGES"\nexit 0\n`,
);
chmodSync(join(SANDBOX, "podman"), 0o755);

const TITLE = readFileSync(join(ROOT, "Dockerfile"), "utf8").match(/org\.opencontainers\.image\.title="([^"]+)"/)?.[1];
const FILTER = `label=org.opencontainers.image.title=${TITLE}`;

function run(args: string[], images: string) {
  rmSync(CALLS, { force: true });
  const proc = Bun.spawnSync({
    cmd: ["/bin/bash", SCRIPT, ...args],
    // Hermetic: pin the engine (a CI runner has a real /usr/bin/docker and the
    // resolver's CI rule would otherwise choose it) and carry no CI variable.
    env: { PATH: `${SANDBOX}:/usr/bin:/bin`, EZCORP_CONTAINER_ENGINE: "podman", STUB_IMAGES: images },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean) : [];
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), calls };
}

const TWO = "842b88981187 2.56 GB\n690f38acdced 4.51 GB\n";

describe("prune-images.sh", () => {
  test("reads the project label from the Dockerfile", () => {
    expect(TITLE).toBe("ezcorp");
  });

  test("lists only dangling images carrying the project label", () => {
    const { calls } = run(["--check"], TWO);
    const listing = calls.find((c) => c.startsWith("images"));
    expect(listing).toContain("--filter dangling=true");
    expect(listing).toContain(`--filter ${FILTER}`);
  });

  test("--check reports and removes nothing", () => {
    const r = run(["--check"], TWO);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("690f38acdced 4.51 GB");
    expect(r.calls.some((c) => c.startsWith("image prune"))).toBe(false);
  });

  test("removes with the label filter — never a bare prune", () => {
    const r = run([], TWO);
    expect(r.exitCode).toBe(0);
    const prunes = r.calls.filter((c) => c.startsWith("image prune"));
    expect(prunes).toEqual([`image prune -f --filter ${FILTER}`]);
  });

  test("nothing superseded: says so and calls no prune", () => {
    const r = run([], "");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no superseded EZCorp images");
    expect(r.calls.some((c) => c.startsWith("image prune"))).toBe(false);
  });

  test("an unknown argument is rejected before any engine call", () => {
    const r = run(["--all"], TWO);
    expect(r.exitCode).toBe(2);
    expect(r.calls).toEqual([]);
  });
});

describe("setup-podman.sh reclaims after a successful start", () => {
  const setup = readFileSync(join(ROOT, "scripts", "setup-podman.sh"), "utf8").split("\n");
  const at = (re: RegExp) => setup.findIndex((l) => re.test(l));

  test("prunes only after the app reported ready, before it exits", () => {
    const ready = at(/ok "ready: \$body"/);
    const prune = at(/prune-images\.sh/);
    const exit = setup.findIndex((l, i) => i > ready && /^\s*exit 0$/.test(l));
    expect(ready).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(ready);
    expect(prune).toBeLessThan(exit);
  });

  test("a prune failure does not fail setup", () => {
    expect(setup[at(/prune-images\.sh/)]).toMatch(/^\s*if ! bash /);
  });

  test("`bun run podman:prune` is this script", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json();
    expect(pkg.scripts["podman:prune"]).toBe("bash scripts/prune-images.sh");
  });
});
