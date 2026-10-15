import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCommandError, RunnerError } from "../src/core";
import { DEFAULT_IMAGE, PodmanRunner } from "../src/podman";

// W4H-12: the external-postgres job ran a Podman guest on a host that never provisioned the
// runner, and the first failure was podman's "image not known" under four lines of cgroup
// warnings. These cases drive initialize() against a fake podman that answers the way an
// unprovisioned hosted runner does, so the refusal is named before any container is started.

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

const WARNINGS = 'time="t" level=warning msg="The cgroupv2 manager is set to systemd but there is no systemd user session available"';
const INFO = JSON.stringify({ host: { security: { rootless: true, seccompEnabled: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "io", "memory", "pids"] } });

/**
 * A fake podman: `info` reports a rootless cgroup v2 host, `image exists` prints the
 * unprovisioned host's warnings and exits with `imageExit`, the probe's `run` records
 * that it was reached and fails, and cleanup commands succeed. Every call is logged.
 */
async function fakeHost(imageExit: number): Promise<{ runner: PodmanRunner; calls: () => Promise<string[]> }> {
  const directory = await mkdtemp(join(tmpdir(), "ez-image-precondition-"));
  directories.push(directory);
  const log = join(directory, "calls.log");
  const podman = join(directory, "podman");
  await writeFile(podman, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "info --format=json") printf '%s\\n' '${INFO}' ;;
  "image exists") printf '%s\\n' '${WARNINGS}' >&2; exit ${imageExit} ;;
  run*) printf 'probe reached\\n' >&2; exit 125 ;;
  *) ;;
esac
`);
  await chmod(podman, 0o755);
  const runner = new PodmanRunner({ root: join(directory, "store"), podman });
  return { runner, calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean) };
}

test("an unprovisioned image is refused by name before any container starts", async () => {
  const host = await fakeHost(1);
  try {
    const failure = await host.runner.initialize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerError);
    expect(failure).toMatchObject({ code: "image_unavailable", stage: "runner", retryable: false });
    const message = (failure as Error).message;
    expect(message).toContain(DEFAULT_IMAGE);
    expect(message).toContain("--pull=never");
    expect(message).toContain("bash scripts/setup-extension-runner-ci.sh --install");
    // podman's warnings are not the message; the named precondition is.
    expect(message).not.toContain("level=warning");
    expect(await host.calls()).toEqual(["info --format=json", `image exists ${DEFAULT_IMAGE}`]);
  } finally { await host.runner.close(); }
});

test("a provisioned image lets the kernel probe run", async () => {
  const host = await fakeHost(0);
  try {
    const failure = await host.runner.initialize().catch((error: unknown) => error);
    // The fake's probe run fails; reaching it is the point.
    expect(failure).toMatchObject({ code: "command_failed", exitCode: 125, message: "probe reached" });
    const calls = await host.calls();
    expect(calls.slice(0, 2)).toEqual(["info --format=json", `image exists ${DEFAULT_IMAGE}`]);
    expect(calls[2]).toStartWith("run --pull=never ");
    expect(calls[2]).toContain(DEFAULT_IMAGE);
  } finally { await host.runner.close(); }
});

test("a podman that cannot answer is a failed command, not a missing image", async () => {
  const host = await fakeHost(125);
  try {
    const failure = await host.runner.initialize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerCommandError);
    expect(failure).toMatchObject({ code: "command_failed", exitCode: 125 });
    expect((failure as Error).message).toContain("level=warning");
    expect(await host.calls()).toEqual(["info --format=json", `image exists ${DEFAULT_IMAGE}`]);
  } finally { await host.runner.close(); }
});

test("a refused initialize can be retried, and the retry asks again", async () => {
  // The runner memoises a successful probe only: a host provisioned after the
  // refusal must not stay refused (prepare() clears the memo on failure).
  const host = await fakeHost(1);
  try {
    await expect(host.runner.initialize()).rejects.toMatchObject({ code: "image_unavailable" });
    await expect(host.runner.initialize()).rejects.toMatchObject({ code: "image_unavailable" });
    expect((await host.calls()).filter(call => call.startsWith("image exists"))).toHaveLength(2);
  } finally { await host.runner.close(); }
});
