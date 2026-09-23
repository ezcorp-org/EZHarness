import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Holds the Linux installer packages (deploy/installer/linux/) to the core
 * they ship and to the package formats' own rules.
 *
 * Each check here targets a mistake that is easy to make and invisible until
 * a user's install fails on a machine no CI runner has:
 *
 *  - The core finds its compose overlays BESIDE ITSELF. Adding an overlay to
 *    the core without adding it to the package makes every packaged install
 *    fail at `compose up` — held by reading the core's own `$HERE/...`
 *    references and requiring the build script to stage each one.
 *  - nfpm's `overrides.<format>.depends` REPLACES the top-level list. The
 *    first build of these packages depended on podman alone, silently
 *    dropping util-linux (flock), openssl and curl.
 *  - The vendored compose binary is downloaded at build time. The build must
 *    refuse one that does not match the pinned checksum — driven for real
 *    below with a curl that serves the wrong bytes.
 *  - The desktop entry runs a subcommand; if the core does not dispatch it,
 *    the menu icon does nothing.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INSTALLER = join(REPO_ROOT, "deploy", "installer");
const LINUX = join(INSTALLER, "linux");
const BUILD = join(LINUX, "build-packages.sh");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release-installers.yml");

const SANDBOX = mkdtempSync(join(tmpdir(), "ezcorp-linux-pkg-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const REQUIRED_DEPENDS = ["podman", "util-linux", "openssl", "curl"];

type Nfpm = { overrides: Record<string, { depends: string[] }>; depends?: string[]; contents: { src: string; dst: string }[] };
const nfpm = async () => Bun.YAML.parse(await Bun.file(join(LINUX, "nfpm.yaml")).text()) as Nfpm;

type ReleaseWorkflow = {
  jobs: {
    "linux-packages": {
      if: string;
      steps: { name?: string; run?: string }[];
    };
  };
};
const releaseWorkflow = async () => Bun.YAML.parse(await Bun.file(RELEASE_WORKFLOW).text()) as ReleaseWorkflow;

describe("release packages use the image run's exact tag commit", () => {
  test("the privileged workflow ignores successful manual image runs on app-v* branches", async () => {
    const job = (await releaseWorkflow()).jobs["linux-packages"];
    expect(job.if).toContain("github.event.workflow_run.event == 'push'");
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  test("the provenance step rejects a different image SHA and a missing Release", async () => {
    const job = (await releaseWorkflow()).jobs["linux-packages"];
    const script = job.steps.find((step) => step.name === "Verify package source matches the published image")?.run;
    expect(script).toBeDefined();

    const repo = mkdtempSync(join(SANDBOX, "release-source-"));
    // Git hooks export GIT_DIR for the parent repo. Pass only the host tools
    // needed here so `git init` cannot reinitialize that shared repository.
    const gitEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const git = (...args: string[]) => {
      const result = Bun.spawnSync({ cmd: ["git", "-C", repo, ...args], env: gitEnv, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git("init", "-q");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "image");
    const imageSha = git("rev-parse", "HEAD");
    git("tag", "app-v1.2.3");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "other");
    const otherSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "app-v1.2.3");

    const bin = join(repo, "bin");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(gh, '#!/usr/bin/env bash\n[ "$FAKE_RELEASE_PRESENT" = 1 ] && [ "$1" = release ] && [ "$2" = view ] && [ "$3" = app-v1.2.3 ]\n');
    chmodSync(gh, 0o755);
    const verify = (
      runEvent: string,
      runSha: string,
      releasePresent: boolean,
      eventName = "workflow_run",
    ) => {
      const result = Bun.spawnSync({
        cmd: ["bash", "-e", "-c", script!],
        cwd: repo,
        env: {
          ...gitEnv,
          PATH: `${bin}:${gitEnv.PATH ?? ""}`,
          GITHUB_EVENT_NAME: eventName,
          PACKAGE_TAG: "app-v1.2.3",
          RUN_EVENT: runEvent,
          RUN_SHA: runSha,
          FAKE_RELEASE_PRESENT: releasePresent ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
    };
    expect(verify("workflow_dispatch", imageSha, true).output).toContain("require a successful release-image tag push");
    expect(verify("push", otherSha, true).output).toContain("no longer points to the image run commit");
    expect(verify("push", imageSha, false).output).toContain("does not exist");
    expect(verify("push", imageSha, true).exitCode).toBe(0);
    expect(verify("", "", true, "workflow_dispatch").exitCode).toBe(0);
  });
});

describe("the package ships everything the core needs beside itself", () => {
  test("every sibling file the core references is staged by the build", async () => {
    const core = await Bun.file(join(INSTALLER, "ezcorp")).text();
    const build = await Bun.file(BUILD).text();
    // Read from the core rather than listed here, so a new overlay added to
    // the core fails this test until the build stages it too.
    const siblings = [...core.matchAll(/"\$HERE\/(compose\.[a-z-]+\.yml)"/g)].map((m) => m[1]);
    expect(siblings.length).toBeGreaterThanOrEqual(4);
    for (const file of new Set(siblings)) {
      expect(build, `${file} is used by the core but not packaged`).toContain(file);
    }
  });

  test("the /usr/bin wrapper execs the exact path nfpm installs the core at", async () => {
    const wrapper = await Bun.file(join(LINUX, "ezcorp-wrapper")).text();
    const target = wrapper.match(/^exec (\S+) "\$@"$/m)?.[1];
    expect(target).toBeDefined();
    const { contents } = await nfpm();
    const libTree = contents.find((c) => c.src.includes("usr/lib/ezcorp"));
    expect(libTree).toBeDefined();
    expect(target?.startsWith(libTree?.dst ?? "\0")).toBe(true);
  });

  test("the desktop entry runs a subcommand the core actually dispatches", async () => {
    const desktop = await Bun.file(join(LINUX, "ezcorp.desktop")).text();
    const sub = desktop.match(/^Exec=ezcorp (\S+)$/m)?.[1];
    expect(sub).toBeDefined();
    const core = await Bun.file(join(INSTALLER, "ezcorp")).text();
    expect(core).toMatch(new RegExp(`^\\s+${sub}\\)\\s+shift; cmd_`, "m"));
    // And it runs in a terminal: the only place the core will ask the
    // extension-runner consent question.
    expect(desktop).toContain("Terminal=true");
  });
});

describe("dependencies survive nfpm's replace-not-merge overrides", () => {
  test("each format's list is complete on its own", async () => {
    const { overrides } = await nfpm();
    for (const format of ["deb", "rpm"]) {
      const names = overrides[format]?.depends.map((d) => d.split(/[\s(>=]/)[0]) ?? [];
      expect(names.sort(), format).toEqual([...REQUIRED_DEPENDS].sort());
    }
  });

  test("no top-level depends that an override would silently discard", async () => {
    expect((await nfpm()).depends).toBeUndefined();
  });

  test("both formats require the same minimum podman", async () => {
    const { overrides } = await nfpm();
    const min = (d: string[]) => d.find((x) => x.startsWith("podman"))?.match(/(\d+\.\d+)/)?.[1];
    expect(min(overrides.deb?.depends ?? [])).toBe(min(overrides.rpm?.depends ?? []));
  });
});

describe("build-packages.sh — what it refuses", () => {
  function stubbedBuild(
    curlBody: string,
    env: Record<string, string | undefined> = {},
    arch = "arm64",
    version = "1.2.3",
  ) {
    const bin = mkdtempSync(join(SANDBOX, "bin-"));
    // curl writes attacker-controlled bytes to wherever -o points.
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { printf '%s' '${curlBody}' > "$2"; exit 0; }; shift; done\nexit 1\n`,
    );
    // nfpm must never be reached when a check fails; if it is, it says so.
    writeFileSync(join(bin, "nfpm"), `#!/usr/bin/env bash\necho NFPM_WAS_CALLED\n`);
    chmodSync(join(bin, "curl"), 0o755);
    chmodSync(join(bin, "nfpm"), 0o755);
    const out = join(SANDBOX, `out-${Math.random().toString(36).slice(2)}`);
    mkdirSync(out);
    const proc = Bun.spawnSync({
      cmd: ["bash", BUILD, arch, version, out],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, EZCORP_PKG_MAINTAINER: "T <t@localhost>", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
  }

  test("a vendored compose binary that does not match the pinned checksum is never packaged", () => {
    const result = stubbedBuild("not the real docker-compose");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("checksum mismatch");
    expect(result.output).not.toContain("NFPM_WAS_CALLED");
  });

  test("no maintainer, no package — the repo declares no contact to invent", () => {
    const result = stubbedBuild("x", { EZCORP_PKG_MAINTAINER: undefined });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("EZCORP_PKG_MAINTAINER");
    expect(result.output).not.toContain("NFPM_WAS_CALLED");
  });

  test.each([["i386", "1.2.3"], ["arm64", "1.2"], ["arm64", "v1.2.3"]])(
    "rejects arch %s / version %s before downloading anything",
    (arch, version) => {
      const result = stubbedBuild("x", {}, arch, version);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toMatch(/unsupported arch|version must be X\.Y\.Z/);
      expect(result.output).not.toContain("checksum mismatch");
      expect(result.output).not.toContain("NFPM_WAS_CALLED");
    },
  );

  test("the pinned checksums are well-formed for both architectures", async () => {
    const lock = await Bun.file(join(LINUX, "compose.lock")).text();
    for (const arch of ["x86_64", "aarch64"]) {
      expect(lock).toMatch(new RegExp(`^COMPOSE_SHA256_${arch}=[0-9a-f]{64}$`, "m"));
    }
  });
});
