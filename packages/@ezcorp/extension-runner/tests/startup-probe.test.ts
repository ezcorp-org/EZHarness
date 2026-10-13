/**
 * The fail-closed startup probe must notice a writable image root.
 *
 * A fake `podman` runs the runner's REAL probe program on this host, where
 * world-writable directories are writable but `/` is not (the probe runs as
 * an unprivileged user, like uid 65534 in a worker). Every other probe field
 * is reported as secure, so the only thing that can make `initialize()`
 * reject is the root-write check. A probe that writes somewhere an
 * unprivileged user can never write (e.g. `/`) cannot tell a read-only root
 * from a writable one.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, PythonPodmanRunner } from "../src";

const dir = mkdtempSync(join(tmpdir(), "runner-startup-probe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Stubs /sys and /proc/net reads so the probe program runs outside a container. */
const shim = join(dir, "shim.js");
writeFileSync(shim, `const fs=require("node:fs");const read=fs.readFileSync;fs.readFileSync=(p,...a)=>/^\\/(sys|proc\\/net)\\//.test(String(p))?"stub":read(p,...a);`);

/** Same stubbing for the Python runner's probe; the program arrives in PROBE_PROGRAM. */
const pyShim = join(dir, "shim.py");
writeFileSync(pyShim, `import builtins, io, os
_open = builtins.open
def _stub(path, *args, **kwargs):
    if str(path).startswith(("/sys/", "/proc/net/")):
        return io.StringIO("stub")
    return _open(path, *args, **kwargs)
builtins.open = _stub
exec(compile(os.environ["PROBE_PROGRAM"], "probe", "exec"))
`);

const fakePodman = join(dir, "podman");
writeFileSync(fakePodman, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "info") {
  console.log(JSON.stringify({ host: { security: { rootless: true, seccompEnabled: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] } }));
} else if (args[0] === "run") {
  const python = args.includes("-c");
  const program = args[args.indexOf(python ? "-c" : "-e") + 1];
  const out = python
    ? Bun.spawnSync({ cmd: ["python3", ${JSON.stringify(pyShim)}], env: { ...process.env, PROBE_PROGRAM: program }, stdout: "pipe", stderr: "pipe" })
    : Bun.spawnSync({ cmd: [process.execPath, "--preload", ${JSON.stringify(shim)}, "-e", program], stdout: "pipe", stderr: "pipe" });
  const { writable } = JSON.parse(new TextDecoder().decode(out.stdout));
  console.log(JSON.stringify({
    uid: 65534, writable, memory: "134217728", swap: "0", cpu: "50000 100000", pids: "32",
    status: "CapEff:\\t0000000000000000\\nNoNewPrivs:\\t1\\nSeccomp:\\t2",
    routes: "Iface\\tDestination", ipv6: "",
  }));
}
process.exit(0);
`);
chmodSync(fakePodman, 0o755);

test("startup rejects a worker whose image root is writable", async () => {
  const root = join(dir, "store");
  const runner = new PodmanRunner({ root, podman: fakePodman });
  try {
    await expect(runner.initialize()).rejects.toMatchObject({ code: "isolation_probe_failed" });
  } finally {
    await runner.close();
  }
});

test("the Python runner's startup also rejects a writable image root", async () => {
  const closure = { pythonVersion: "3.12.0", lockDigest: `sha256:${"a".repeat(64)}`, distributions: [], models: [], resourceClass: "cpu" };
  const runner = new PythonPodmanRunner({ root: join(dir, "py-store"), podman: fakePodman, closure });
  try {
    await expect(runner.initialize()).rejects.toMatchObject({ code: "isolation_probe_failed" });
  } finally {
    await runner.close();
  }
});
