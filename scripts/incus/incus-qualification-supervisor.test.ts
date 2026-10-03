import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

for (const filename of ["incus-qualification-supervisor.test.py",
  "incus-qualification-supervisor-fault.test.py",
  "incus-qualification-fault-authorize.test.py"]) test(filename, async () => {
  const result = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn("python3", [join(import.meta.dir, filename)], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    let killGrace: ReturnType<typeof setTimeout> | undefined;
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const signalGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch { /* process already exited */ }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killGrace = setTimeout(() => signalGroup("SIGKILL"), 2_000);
    }, 20_000);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timeout);
      if (killGrace) clearTimeout(killGrace);
      resolve({ code, stderr, timedOut });
    });
  });
  if (result.timedOut || result.code !== 0) {
    throw new Error(`${filename} exited with code ${result.code} (timed out: ${result.timedOut})\n${result.stderr}`);
  }
  expect(result.stderr).toContain("OK");
}, 25_000);
