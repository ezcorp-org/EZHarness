import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o700 });
}

test("long persistent state keeps the authenticated runner transport below the Unix-path limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "production-lifecycle-launch-"));
  const bin = join(directory, "bin");
  const state = await mkdtemp(join(tmpdir(), `ez-r4-runner-private-socket-regression-${"x".repeat(24)}-`));
  const receipt = join(directory, "receipt");
  const compose = join(directory, "compose.yml");
  const runnerTransport = join(directory, "runner-transport.txt");
  const commandEnvironment = join(directory, "command-environment.txt");
  await mkdir(bin, { recursive: true });
  await executable(join(bin, "docker"), `#!/bin/sh
set -eu
case "$1" in
  container|network) exit 1 ;;
  image) printf 'image_id=sha256:test revision=test\n'; exit 0 ;;
  compose)
    compose=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-f" ]; then compose="$2"; shift 2; continue; fi
      shift
    done
    [ -z "$compose" ] || cp "$compose" "$FAKE_COMPOSE"
    printf '%s\n%s\n' "$RUNNER_ROOT" "$RUNNER_TOKEN" > "$FAKE_RUNNER_TRANSPORT"
    exit 0 ;;
esac
exit 1
`);
  await executable(join(bin, "curl"), `#!/bin/sh
set -eu
out=""
cookie=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -c) cookie="$2"; shift 2 ;;
    -b|-H|--data) shift 2 ;;
    *) shift ;;
  esac
done
case "\${out}" in
  *key.json) body='{"key":"test-api-key"}'; code=201 ;;
  *setup.json) body='{}'; code=201 ;;
  *) body='{}'; code=200 ;;
esac
[ -z "$cookie" ] || : > "$cookie"
[ -z "$out" ] || printf '%s\n' "$body" > "$out"
printf '%s' "$code"
`);
  await executable(join(bin, "jq"), "#!/bin/sh\nprintf '%s\\n' test-api-key\n");

  let child: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await writeFile(join(state, "persistent-sentinel.txt"), "retain persistent state");
    const launched = Bun.spawn([
      "bash",
      "scripts/verify-production-image-lifecycle.sh",
      "--",
      "bun",
      "-e",
      'const {inspectProductionRunner}=await import("./scripts/lib/production-lifecycle-client.ts");const inspection=await inspectProductionRunner("launcher-readiness");if(inspection.id!=="launcher-readiness"||inspection.state!=="unknown")throw new Error("Unexpected runner inspection: "+JSON.stringify(inspection));await Bun.write(process.env.PROBE_OUTPUT,JSON.stringify({stateRoot:process.env.EZ_PRODUCTION_RUN_ROOT,id:inspection.id,state:inspection.state})+"\\n");',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        EZ_PRODUCTION_IMAGE: "lifecycle-launch-test",
        EZ_PRODUCTION_RECEIPT_DIR: receipt,
        EZ_PRODUCTION_STATE_DIR: state,
        EZ_PRODUCTION_PORT: "4999",
        EZ_PRODUCTION_COMPOSE_PROJECT: "lifecycle-launch-test",
        EZ_PRODUCTION_APP_CONTAINER: "lifecycle-launch-test-app",
        EZ_PRODUCTION_APP_UID: "0",
        EZ_PRODUCTION_APP_GID: "0",
        FAKE_COMPOSE: compose,
        FAKE_RUNNER_TRANSPORT: runnerTransport,
        PROBE_OUTPUT: commandEnvironment,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    child = launched;
    deadline = setTimeout(() => {
      timedOut = true;
      child!.kill("SIGTERM");
    }, 20_000);
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(launched.stdout).text(),
      new Response(launched.stderr).text(),
    ]);
    expect(timedOut).toBe(false);
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
    expect(await readFile(commandEnvironment, "utf8")).toBe(`${JSON.stringify({ stateRoot: state, id: "launcher-readiness", state: "unknown" })}\n`);
    const generatedCompose = await readFile(compose, "utf8");
    const [mountedRunnerRoot, mountedRunnerToken] = (await readFile(runnerTransport, "utf8")).trim().split("\n");
    expect(mountedRunnerToken).toBeDefined();
    expect(mountedRunnerRoot).toMatch(/^\/tmp\/ez-production-lifecycle-[^/]+\/s$/);
    expect(`${mountedRunnerRoot}/.private-${"0".repeat(36)}/runner.sock`.length).toBeLessThan(108);
    expect(generatedCompose).toContain("$" + "{RUNNER_ROOT}:/run/ez-extension-runner:ro");
    expect(generatedCompose).toContain("$" + "{RUN_ROOT}/app-data:/app/data");
    expect(generatedCompose).toContain("$" + "{RUN_ROOT}/extension-state:/app/.ezcorp");
    expect(generatedCompose).not.toContain("$" + "{RUN_ROOT}/socket:/run/ez-extension-runner:ro");
    expect(await readFile(join(state, "persistent-sentinel.txt"), "utf8")).toBe("retain persistent state");
    expect(existsSync(mountedRunnerRoot!)).toBe(false);
    expect(existsSync(mountedRunnerToken!)).toBe(false);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (child) await child.exited;
    await rm(state, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
