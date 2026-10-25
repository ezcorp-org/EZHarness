/**
 * The real-auth lane stops its app before its extension runner.
 *
 * Playwright starts the lane's webServer (`scripts/start-real-extension-preview.sh`) in its own process group
 * and stops it by signalling that whole group. The runner was a plain background child of the script, so the
 * group SIGTERM reached the runner at the same moment as the app: an app build call still open to the runner
 * got "socket hang up" (real-auth lane, run 40217994555: the bundled scratchpad build at teardown). The
 * script's cleanup() already stops the app first and the runner second, but only a runner outside the group
 * actually waits for it. This test plays Playwright: it starts the script in a new group with a fake `bun` that
 * keeps the runner and the app alive and records every signal, sends SIGTERM to the group, and reads the order.
 */
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

/** Wait for an observed state; the test budget is the only bound. */
async function until(observed: () => Promise<boolean>): Promise<void> {
  while (!(await observed())) await Bun.sleep(20);
}

/** The fake bun: the runner and the app stay up and log their own signals; every other call exits at once. */
const FAKE_BUN = `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
const log = (event) => appendFileSync(process.env.STOP_RECORD, event + "\\n");
const args = process.argv.slice(2);
if (args[0] === "-e" && args[1].includes("randomBytes")) writeFileSync(process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE, "test-credential");
const role = args.includes("packages/@ezcorp/extension-runner/src/main.ts") ? "runner" : args[0] === "build/index.js" ? "app" : null;
if (role) {
  log(role + "-started");
  log(role + "-pid:" + process.pid);
  process.on("SIGTERM", () => {
    log(role + "-term");
    // The app drains its open requests before it exits; the runner must still be up while it does.
    setTimeout(() => { log(role + "-exit"); process.exit(0); }, role === "app" ? 300 : 0);
  });
  setInterval(() => {}, 1000);
}
`;

/** Start the lane script the way Playwright does (its own process group) and wait until both servers are up. */
async function startLane(run: (lane: { pid: number; exited: Promise<number>; stdout: Promise<string>; events: () => Promise<string[]> }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "real-lane-stop-"));
  const record = join(directory, "events.log");
  await writeFile(join(directory, "bun"), FAKE_BUN);
  await chmod(join(directory, "bun"), 0o700);
  const child = Bun.spawn(["bash", "scripts/start-real-extension-preview.sh"], {
    cwd: root,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, STOP_RECORD: record, EZCORP_BROWSER_COVERAGE: "" },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const events = async () => (await readFile(record, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  try {
    await until(async () => (await events()).includes("app-started") && (await events()).includes("runner-started"));
    await run({ pid: child.pid, exited: child.exited, stdout: new Response(child.stdout).text(), events });
  } finally {
    // A failing run must not leave its servers behind: the group, and the runner if it left the group.
    const runnerPid = Number((await events()).find((event) => event.startsWith("runner-pid:"))?.slice("runner-pid:".length));
    for (const target of [-child.pid, ...(runnerPid ? [runnerPid] : [])]) {
      try {
        process.kill(target, "SIGKILL");
      } catch (error) {
        // Already gone, which is the normal end.
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("a group SIGTERM stops the app first, and the runner only after the app has exited", async () => {
  await startLane(async (lane) => {
    process.kill(-lane.pid, "SIGTERM");
    const [, stdout] = await Promise.all([lane.exited, lane.stdout]);
    // The lane's own log names the two stops in order, for a CI run log to show.
    expect(stdout.split("\n").filter((line) => line.startsWith("real lane: "))).toEqual(["real lane: app stopped", "real lane: runner stopped"]);
    await until(async () => (await lane.events()).includes("runner-exit"));
    const order = await lane.events();
    expect(order.indexOf("app-exit")).toBeGreaterThan(-1);
    // The runner is stopped once, and only after the app has finished draining.
    expect(order.filter((event) => event === "runner-term")).toHaveLength(1);
    expect(order.indexOf("runner-term")).toBeGreaterThan(order.indexOf("app-exit"));
  });
}, 30_000);

test("a group SIGKILL, where cleanup() cannot run, still stops the runner instead of leaving it behind", async () => {
  await startLane(async (lane) => {
    const runnerPid = Number((await lane.events()).find((event) => event.startsWith("runner-pid:"))!.slice("runner-pid:".length));
    process.kill(-lane.pid, "SIGKILL");
    await lane.exited;
    const alive = () => { try { process.kill(runnerPid, 0); return true; } catch { return false; } };
    // Poll a bounded number of times, so a runner that is left behind fails this test (and its cleanup runs)
    // instead of hanging it.
    for (let poll = 0; poll < 250 && alive(); poll++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  });
}, 30_000);

test("a host without setsid or setpriv refuses by name instead of stopping the runner with the app", async () => {
  // A PATH that holds only the fake bun: no util-linux tools at all.
  const directory = await mkdtemp(join(tmpdir(), "real-lane-tools-"));
  try {
    await writeFile(join(directory, "bun"), FAKE_BUN);
    await chmod(join(directory, "bun"), 0o700);
    const child = Bun.spawn([Bun.which("bash")!, "scripts/start-real-extension-preview.sh"], {
      cwd: root,
      env: { ...process.env, PATH: directory, STOP_RECORD: join(directory, "events.log") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(status).toBe(127);
    expect(stderr.trim()).toBe("start-real-extension-preview.sh needs setsid (util-linux) to stop the extension runner after the app");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
