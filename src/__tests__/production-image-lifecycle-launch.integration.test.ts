import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

type LaunchFixture = {
  bin: string;
  commandEnvironment: string;
  compose: string;
  directory: string;
  dockerLog: string;
  receipt: string;
  runnerTransport: string;
  setsidRelease: string;
  setsidStarter: string;
  state: string;
};

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o700 });
}

async function launcherDiagnostics(receipt: string): Promise<string> {
  const read = async (name: string) => {
    try {
      return await readFile(join(receipt, name), "utf8");
    } catch (error) {
      return `<unavailable: ${String(error)}>`;
    }
  };
  return `runner.log:\n${await read("runner.log")}\ncommand.log:\n${await read("command.log")}`;
}

async function makeFixture(): Promise<LaunchFixture> {
  const directory = await mkdtemp(join(tmpdir(), "production-lifecycle-launch-"));
  const bin = join(directory, "bin");
  const state = await mkdtemp(join(tmpdir(), `ez-r4-runner-private-socket-regression-${"x".repeat(24)}-`));
  const fixture = {
    bin,
    commandEnvironment: join(directory, "command-environment.txt"),
    compose: join(directory, "compose.yml"),
    directory,
    dockerLog: join(directory, "docker.log"),
    receipt: join(directory, "receipt"),
    runnerTransport: join(directory, "runner-transport.txt"),
    setsidRelease: join(directory, "setsid-release"),
    setsidStarter: join(directory, "setsid-starter.pid"),
    state,
  };
  await mkdir(bin, { recursive: true });
  await executable(join(bin, "docker"), `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
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
  await executable(join(bin, "jq"), "#!/bin/sh\nprintf '%s\n' test-api-key\n");
  const realSetsid = Bun.which("setsid");
  if (!realSetsid) throw new Error("setsid is required for the launcher fixture");
  await executable(join(bin, "setsid"), `#!/bin/sh
set -eu
child=""
stop() {
  [ -z "$child" ] || kill -TERM "$child" 2>/dev/null
  [ -z "$child" ] || wait "$child" 2>/dev/null
  exit 130
}
trap stop INT TERM
printf '%s\n' "$$" > "$FAKE_SETSID_STARTER"
while [ ! -f "$FAKE_SETSID_RELEASE" ]; do
  sleep 0.01 & child=$!
  wait "$child" || true
  child=""
done
exec "$REAL_SETSID" "$@"
`);
  return fixture;
}

function launch(fixture: LaunchFixture, command: string[], environment: Record<string, string> = {}, detached = false) {
  return Bun.spawn(["bash", "scripts/verify-production-image-lifecycle.sh", "--", ...command], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      EZ_PRODUCTION_IMAGE: "lifecycle-launch-test",
      EZ_PRODUCTION_RECEIPT_DIR: fixture.receipt,
      EZ_PRODUCTION_STATE_DIR: fixture.state,
      EZ_PRODUCTION_PORT: "4999",
      EZ_PRODUCTION_COMPOSE_PROJECT: "lifecycle-launch-test",
      EZ_PRODUCTION_APP_CONTAINER: "lifecycle-launch-test-app",
      EZ_PRODUCTION_APP_UID: "0",
      EZ_PRODUCTION_APP_GID: "0",
      FAKE_COMPOSE: fixture.compose,
      FAKE_DOCKER_LOG: fixture.dockerLog,
      FAKE_RUNNER_TRANSPORT: fixture.runnerTransport,
      FAKE_SETSID_RELEASE: fixture.setsidRelease,
      FAKE_SETSID_STARTER: fixture.setsidStarter,
      PROBE_OUTPUT: fixture.commandEnvironment,
      REAL_SETSID: Bun.which("setsid") ?? "",
      ...environment,
    },
    detached,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function removeFixture(fixture: LaunchFixture): Promise<void> {
  await rm(fixture.state, { recursive: true, force: true });
  await rm(fixture.directory, { recursive: true, force: true });
}

const cancellationObservationMs = 10_000;
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await sleep(10);
  }
}

async function readReadyFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (value) return value;
    } catch {
      // The producer may have created the path before its first write.
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for content in ${path}`);
}

type ProcessIdentity = {
  processGroup: number;
  startTime: string;
};

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return await Promise.race([promise, sleep(timeoutMs).then(() => undefined)]);
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    return Number.isSafeInteger(processGroup) && processGroup > 1 && startTime ? { processGroup, startTime } : undefined;
  } catch {
    return undefined;
  }
}

async function hasIdentity(pid: number, expected: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity(pid);
  return current?.processGroup === expected.processGroup && current.startTime === expected.startTime;
}

async function stopOwnedProcessGroup(processGroup: number, owned: Array<{ pid: number; identity: ProcessIdentity }>): Promise<void> {
  const liveOwned = async () => (await Promise.all(owned.map(async ({ pid, identity }) => (await hasIdentity(pid, identity)) ? { pid, identity } : undefined))).filter((process): process is { pid: number; identity: ProcessIdentity } => process !== undefined);
  const send = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-processGroup, signal);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  if (!(await liveOwned()).some(({ identity }) => identity.processGroup === processGroup)) return;
  send("SIGTERM");
  await sleep(200);
  if ((await liveOwned()).some(({ identity }) => identity.processGroup === processGroup)) {
    send("SIGKILL");
    await sleep(200);
  }
}

async function finishOwnedLauncher(
  child: ReturnType<typeof Bun.spawn> | undefined,
  owned: Array<{ pid: number; identity: ProcessIdentity }>,
): Promise<void> {
  if (!child) return;
  const groups = [...new Set(owned.map(({ identity }) => identity.processGroup))];
  for (const processGroup of groups) await stopOwnedProcessGroup(processGroup, owned);
  if ((await settlesWithin(child.exited, 1_000)) === undefined) {
    for (const processGroup of groups) await stopOwnedProcessGroup(processGroup, owned);
  }
}

test("long persistent state keeps the authenticated runner transport below the Unix-path limit", async () => {
  const fixture = await makeFixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await writeFile(join(fixture.state, "persistent-sentinel.txt"), "retain persistent state");
    await writeFile(fixture.setsidRelease, "release");
    const launched = launch(fixture, [
      "bun",
      "-e",
      'const {inspectProductionRunner}=await import("./scripts/lib/production-lifecycle-client.ts");const inspection=await inspectProductionRunner("launcher-readiness");if(inspection.id!=="launcher-readiness"||inspection.state!=="unknown")throw new Error("Unexpected runner inspection: "+JSON.stringify(inspection));await Bun.write(process.env.PROBE_OUTPUT,JSON.stringify({stateRoot:process.env.EZ_PRODUCTION_RUN_ROOT,id:inspection.id,state:inspection.state})+"\\n");',
    ]);
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
    const diagnostics = await launcherDiagnostics(fixture.receipt);
    expect(timedOut, `launcher exceeded the 20s deadline\n${diagnostics}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(false);
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
    expect(await readFile(fixture.commandEnvironment, "utf8")).toBe(`${JSON.stringify({ stateRoot: fixture.state, id: "launcher-readiness", state: "unknown" })}\n`);
    const generatedCompose = await readFile(fixture.compose, "utf8");
    const [mountedRunnerRoot, mountedRunnerToken] = (await readFile(fixture.runnerTransport, "utf8")).trim().split("\n");
    expect(mountedRunnerToken).toBeDefined();
    expect(mountedRunnerRoot).toMatch(/^\/tmp\/ez-production-lifecycle-[^/]+\/s$/);
    expect(`${mountedRunnerRoot}/.private-${"0".repeat(36)}/runner.sock`.length).toBeLessThan(108);
    expect(generatedCompose).toContain("$" + "{RUNNER_ROOT}:/run/ez-extension-runner:ro");
    expect(generatedCompose).toContain("$" + "{RUN_ROOT}/app-data:/app/data");
    expect(generatedCompose).toContain("$" + "{RUN_ROOT}/extension-state:/app/.ezcorp");
    expect(generatedCompose).not.toContain("$" + "{RUN_ROOT}/socket:/run/ez-extension-runner:ro");
    expect(await readFile(join(fixture.state, "persistent-sentinel.txt"), "utf8")).toBe("retain persistent state");
    expect(existsSync(mountedRunnerRoot!)).toBe(false);
    expect(existsSync(mountedRunnerToken!)).toBe(false);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (child) await child.exited;
    await removeFixture(fixture);
  }
}, 30_000);

test("launcher cancellation reaps its verifier and runner before streams drain", async () => {
  const fixture = await makeFixture();
  const verifierReady = join(fixture.directory, "verifier-ready");
  const verifierPidFile = join(fixture.directory, "verifier.pid");
  const verifierDescendantPidFile = join(fixture.directory, "verifier-descendant.pid");
  const runnerPidFile = join(fixture.directory, "runner.pid");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const owned: Array<{ pid: number; identity: ProcessIdentity }> = [];
  try {
    await writeFile(fixture.setsidRelease, "release");
    const launched = launch(fixture, [
      "bun",
      "-e",
      'const descendant=Bun.spawn([process.execPath,"-e",`process.on("SIGTERM",()=>{});setInterval(()=>{},1_000)`],{stdout:"ignore",stderr:"ignore"});await Bun.write(process.env.VERIFIER_PID_FILE,String(process.pid));await Bun.write(process.env.VERIFIER_DESCENDANT_PID_FILE,String(descendant.pid));await Bun.write(process.env.RUNNER_PID_FILE,process.env.EZ_PRODUCTION_RUNNER_PID);await Bun.write(process.env.VERIFIER_READY_FILE,"ready");setInterval(()=>{},1_000);',
    ], {
      RUNNER_PID_FILE: runnerPidFile,
      VERIFIER_DESCENDANT_PID_FILE: verifierDescendantPidFile,
      VERIFIER_PID_FILE: verifierPidFile,
      VERIFIER_READY_FILE: verifierReady,
    }, true);
    child = launched;
    const launcherIdentity = await processIdentity(launched.pid);
    expect(launcherIdentity).toBeDefined();
    owned.push({ pid: launched.pid, identity: launcherIdentity! });
    expect(launcherIdentity!.processGroup).toBeGreaterThan(1);
    const stdout = new Response(launched.stdout).text();
    const stderr = new Response(launched.stderr).text();
    try {
      await waitForFile(verifierReady);
    } catch (error) {
      throw new Error(`${String(error)}\n${await launcherDiagnostics(fixture.receipt)}\nlauncher_exit=${await settlesWithin(child.exited, 100)}\nstdout=${await settlesWithin(stdout, 100)}\nstderr=${await settlesWithin(stderr, 100)}`);
    }
    const observedVerifierPid = Number(await readFile(verifierPidFile, "utf8"));
    const verifierDescendantPid = Number(await readFile(verifierDescendantPidFile, "utf8"));
    const runnerPid = Number(await readFile(runnerPidFile, "utf8"));
    expect(observedVerifierPid).toBeGreaterThan(1);
    expect(verifierDescendantPid).toBeGreaterThan(1);
    expect(runnerPid).toBeGreaterThan(1);
    const [runnerRoot] = (await readFile(fixture.runnerTransport, "utf8")).trim().split("\n");
    const reportedGroupFile = join(runnerRoot!, "..", "verification-group.pid");
    await waitForFile(reportedGroupFile);
    const reportedVerifierGroup = Number(await readReadyFile(reportedGroupFile));
    const verifierIdentity = await processIdentity(observedVerifierPid);
    const verifierDescendantIdentity = await processIdentity(verifierDescendantPid);
    const runnerIdentity = await processIdentity(runnerPid);
    expect(verifierIdentity).toBeDefined();
    expect(verifierDescendantIdentity).toBeDefined();
    expect(runnerIdentity).toBeDefined();
    owned.push(
      { pid: observedVerifierPid, identity: verifierIdentity! },
      { pid: verifierDescendantPid, identity: verifierDescendantIdentity! },
      { pid: runnerPid, identity: runnerIdentity! },
    );
    expect(reportedVerifierGroup).toBe(verifierIdentity!.processGroup);
    expect(await hasIdentity(observedVerifierPid, verifierIdentity!)).toBe(true);
    expect(await hasIdentity(verifierDescendantPid, verifierDescendantIdentity!)).toBe(true);
    expect(await hasIdentity(runnerPid, runnerIdentity!)).toBe(true);

    child.kill("SIGTERM");
    const [launcherExit, stdoutResult, stderrResult] = await Promise.all([
      settlesWithin(child.exited, cancellationObservationMs),
      settlesWithin(stdout, cancellationObservationMs),
      settlesWithin(stderr, cancellationObservationMs),
    ]);
    const stdoutDrained = stdoutResult !== undefined;
    const stderrDrained = stderrResult !== undefined;
    const dockerLog = await readFile(fixture.dockerLog, "utf8");
    const result = {
      composeDown: dockerLog.includes("down --volumes --remove-orphans"),
      launcherExit,
      runnerAlive: await hasIdentity(runnerPid, runnerIdentity!),
      stderrDrained,
      stdoutDrained,
      verifierAlive: await hasIdentity(observedVerifierPid, verifierIdentity!),
      verifierDescendantAlive: await hasIdentity(verifierDescendantPid, verifierDescendantIdentity!),
    };
    const diagnostics = await launcherDiagnostics(fixture.receipt);
    expect(result, `${diagnostics}\n${dockerLog}`).toEqual({
      composeDown: true,
      launcherExit: 130,
      runnerAlive: false,
      stderrDrained: true,
      stdoutDrained: true,
      verifierAlive: false,
      verifierDescendantAlive: false,
    });
  } finally {
    await finishOwnedLauncher(child, owned);
    await removeFixture(fixture);
  }
}, 25_000);

test("launcher cancellation before verifier group readiness reaps its owned starter", async () => {
  const fixture = await makeFixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const owned: Array<{ pid: number; identity: ProcessIdentity }> = [];
  try {
    const launched = launch(fixture, ["bun", "-e", 'throw new Error("verifier must not start before its group is ready");'], {}, true);
    child = launched;
    const launcherIdentity = await processIdentity(launched.pid);
    expect(launcherIdentity).toBeDefined();
    owned.push({ pid: launched.pid, identity: launcherIdentity! });
    const stdout = new Response(launched.stdout).text();
    const stderr = new Response(launched.stderr).text();
    await waitForFile(fixture.setsidStarter);
    const starterPid = Number(await readFile(fixture.setsidStarter, "utf8"));
    expect(starterPid).toBeGreaterThan(1);
    const starterIdentity = await processIdentity(starterPid);
    expect(starterIdentity).toBeDefined();
    owned.push({ pid: starterPid, identity: starterIdentity! });
    expect(await hasIdentity(starterPid, starterIdentity!)).toBe(true);

    child.kill("SIGTERM");
    const [launcherExit, stdoutResult, stderrResult] = await Promise.all([
      settlesWithin(child.exited, cancellationObservationMs),
      settlesWithin(stdout, cancellationObservationMs),
      settlesWithin(stderr, cancellationObservationMs),
    ]);
    const stdoutDrained = stdoutResult !== undefined;
    const stderrDrained = stderrResult !== undefined;
    const dockerLog = await readFile(fixture.dockerLog, "utf8");
    expect({
      composeDown: dockerLog.includes("down --volumes --remove-orphans"),
      launcherExit,
      starterAlive: await hasIdentity(starterPid, starterIdentity!),
      stderrDrained,
      verifierGroupNeverReleased: !existsSync(fixture.setsidRelease),
      verificationLogAbsent: !existsSync(join(fixture.receipt, "verification.log")),
      stdoutDrained,
    }, `${await launcherDiagnostics(fixture.receipt)}\n${dockerLog}`).toEqual({
      composeDown: true,
      launcherExit: 130,
      starterAlive: false,
      stderrDrained: true,
      verifierGroupNeverReleased: true,
      verificationLogAbsent: true,
      stdoutDrained: true,
    });
  } finally {
    await finishOwnedLauncher(child, owned);
    await removeFixture(fixture);
  }
}, 25_000);

test("launcher preserves verifier and tee failure exits", async () => {
  for (const failure of [
    { command: ["bun", "-e", "process.exit(17)"], expectedExit: 17, fakeTeeExit: undefined },
    { command: ["bun", "-e", ""], expectedExit: 23, fakeTeeExit: "23" },
  ]) {
    const fixture = await makeFixture();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(fixture.setsidRelease, "release");
      if (failure.fakeTeeExit) {
        await executable(join(fixture.bin, "tee"), "#!/bin/sh\ncat >/dev/null\nexit \"$FAKE_TEE_EXIT\"\n");
      }
      const launched = launch(fixture, failure.command, failure.fakeTeeExit ? { FAKE_TEE_EXIT: failure.fakeTeeExit } : {});
      child = launched;
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(launched.stdout).text(),
        new Response(launched.stderr).text(),
      ]);
      expect(exit, `${stdout}\n${stderr}`).toBe(failure.expectedExit);
      const commandLog = await readFile(join(fixture.receipt, "command.log"), "utf8");
      expect(commandLog).toContain(`command_exit=${failure.expectedExit}`);
      expect(commandLog).toContain("verifier_cleanup_exit=0");
      expect(await readFile(fixture.dockerLog, "utf8")).toContain("down --volumes --remove-orphans");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      if (child) await child.exited;
      await removeFixture(fixture);
    }
  }
}, 25_000);
