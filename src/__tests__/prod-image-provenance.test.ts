import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Holds the prod image's provenance stamping — compose.prod.yml's build args,
 * the wrapper that supplies them, and the Dockerfile layer that makes Podman
 * honour them — against each other.
 *
 * ## The bugs these exist to prevent
 *
 * 1. `bun run podman --prod up --build` produced images labelled
 *    `revision=unknown` with EZCORP_IMAGE_SHA=unknown, so every local build
 *    shared one migration circuit-breaker key. compose.prod.yml now passes the
 *    wrapper's detected commit; the arg names must match what the wrapper
 *    exports and what the Dockerfile declares, or the value silently drops.
 * 2. Podman/Buildah can satisfy an ENV/LABEL from cache when only a build-arg
 *    value changed — measured: the second build carried the FIRST build's SHA.
 *    A RUN that writes the args must sit between the ARGs and the ENV/LABEL
 *    that read them. Its POSITION is the property, so that is what is held.
 *
 * ## Why this is not a tautology
 *
 * Names are cross-read between three files; the Dockerfile is checked by line
 * order, not by the presence of a string.
 */

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => Bun.file(join(ROOT, p)).text();

describe("prod image provenance", () => {
  test("compose.prod.yml passes the commit and source state the wrapper exports", async () => {
    const compose = await read("compose.prod.yml");
    const wrapper = await read("scripts/podman-compose.sh");
    for (const exported of ["EZCORP_BUILD_COMMIT_DEFAULT", "EZCORP_BUILD_SOURCE_STATE_DEFAULT"]) {
      expect(wrapper).toMatch(new RegExp(`^export ${exported}$`, "m"));
      expect(compose).toContain(`\${${exported}:-unknown}`);
    }
    for (const exported of ["EZCORP_BUILD_VERSION_DEFAULT", "EZCORP_BUILD_CREATED_DEFAULT"]) {
      expect(wrapper).toMatch(new RegExp(`^export ${exported}=`, "m"));
      expect(compose).toContain(`\${${exported}:-`);
    }
    expect(compose).toMatch(/^\s+REVISION: \$\{EZCORP_BUILD_COMMIT:-\$\{EZCORP_BUILD_COMMIT_DEFAULT:-unknown\}\}$/m);
  });

  test("every build arg compose.prod.yml passes is declared by the Dockerfile", async () => {
    const compose = await read("compose.prod.yml");
    const dockerfile = await read("Dockerfile");
    const args = [...compose.matchAll(/^\s{8}([A-Z_]+): \$\{/gm)].map((m) => m[1]);
    expect(args).toEqual(expect.arrayContaining(["VERSION", "REVISION", "CREATED", "EZCORP_BUILD_SOURCE_STATE"]));
    for (const arg of args) expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=`, "m"));
  });

  test("a RUN materializes the args between the ARGs and the ENV/LABEL that read them", async () => {
    const lines = (await read("Dockerfile")).split("\n");
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const argRevision = at(/^ARG REVISION=/);
    const argState = at(/^ARG EZCORP_BUILD_SOURCE_STATE=/);
    const provenance = at(/^RUN printf .*revision=/);
    const envSha = at(/^ENV EZCORP_IMAGE_SHA=\$REVISION$/);
    const labelRevision = at(/org\.opencontainers\.image\.revision=\$REVISION/);
    for (const i of [argRevision, argState, provenance, envSha, labelRevision]) expect(i).toBeGreaterThan(-1);
    expect(provenance).toBeGreaterThan(Math.max(argRevision, argState));
    expect(provenance).toBeLessThan(Math.min(envSha, labelRevision));
  });
});

/** What the real wrapper exports, read back through a stub Compose client. */
function wrapperExports(env: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "prod-provenance-"));
  try {
    writeFileSync(join(dir, "docker-compose"), "#!/bin/sh\nenv | grep '^EZCORP_BUILD_'\n");
    chmodSync(join(dir, "docker-compose"), 0o755);
    const sock = join(dir, "podman.sock");
    const server = Bun.listen({ unix: sock, socket: { data() {} } });
    const envFile = join(dir, "env.prod");
    writeFileSync(envFile, "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml\n");
    try {
      const proc = Bun.spawnSync({
        cmd: ["/bin/bash", join(ROOT, "scripts", "podman-compose.sh"), "--prod", "config"],
        env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, PODMAN_SOCKET: sock, EZ_COMPOSE_ENV_FILE: envFile, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      return Object.fromEntries(
        proc.stdout.toString().trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
    } finally {
      server.stop(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("prod image provenance — what the wrapper actually derives", () => {
  test("VERSION default is package.json's version, read without jq or bun", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json();
    expect(wrapperExports().EZCORP_BUILD_VERSION_DEFAULT).toBe(pkg.version);
  });

  test("CREATED default is HEAD's commit time, not the wall clock", () => {
    const head = Bun.spawnSync({ cmd: ["git", "-C", ROOT, "show", "-s", "--format=%cI", "HEAD"], stdout: "pipe" })
      .stdout.toString()
      .trim();
    const first = wrapperExports().EZCORP_BUILD_CREATED_DEFAULT;
    expect(first).toBe(head);
    // Stable across invocations — a wall-clock value would bust the build cache every time.
    expect(wrapperExports().EZCORP_BUILD_CREATED_DEFAULT).toBe(first);
  });
});

