#!/usr/bin/env node
// Shared CI/operator proof. Every worker uses a separate Stage2 namespace,
// the production launcher and proxy, and an owned reachable echo destination.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID();
const failures = [];
function integer(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}
function kernelRecords(args) {
  return command("journalctl", ["-k", "--no-pager", "-o", "json", ...args])
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function ownedContainers() {
  return command("podman", ["ps", "-aq", "--filter", `label=ezcorp.stage2-proof=${runId}`])
    .trim().split("\n").filter(Boolean);
}

async function main() {
  const seconds = integer("EZCORP_STAGE2_SOAK_SECONDS", 300, 86_400);
  const requests = integer("EZCORP_STAGE2_SOAK_REQUESTS", 100, 100_000);
  const workers = integer("EZCORP_STAGE2_SOAK_WORKERS", 4, 20);
  const baseline = kernelRecords(["-n", "1"])[0];
  if (!baseline?.__CURSOR) throw new Error("A readable kernel journal cursor is required");
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: workers }, (_, worker) => new Promise(resolveResult => {
    const child = spawn("bash", [resolve(root, "scripts/stage2-raw-network-proof.sh"), "--soak"], {
      cwd: root, env: { ...process.env,
        EZCORP_STAGE2_RUN_ID: runId,
        EZCORP_STAGE2_SOAK_SECONDS: String(seconds),
        EZCORP_STAGE2_SOAK_REQUESTS: String(requests),
        EZCORP_STAGE2_KILL_WORKER: process.env.EZCORP_STAGE2_KILL_WORKER === "1" && worker === 0 ? "1" : "0",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), (seconds + 45) * 1_000);
    child.once("error", error => { stderr += error.message; });
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      let receipt;
      try {
        if (exit !== 0 || signal !== null) throw new Error(`worker failed (exit=${exit}, signal=${signal}): ${stderr.trim()}`);
        if (stderr.trim()) throw new Error(`worker wrote unexpected stderr: ${stderr.trim()}`);
        receipt = JSON.parse(stdout.trim());
        const soak = receipt.soak;
        if (receipt.childExit !== 0 || receipt.childSignal !== null ||
            receipt.upstreamConnections !== requests + 1 || receipt.acceptedConnections !== 0 || receipt.openConnections !== 0 ||
            !soak || soak.requests !== requests || soak.durationMs !== seconds * 1_000 || soak.elapsedMs < soak.durationMs ||
            soak.samples < seconds * 2 || soak.peak < 1 || soak.peak >= soak.maximum / 2) throw new Error("incomplete or invalid load receipt");
      } catch (error) { failures.push(`worker ${worker}: ${error.message}`); }
      resolveResult({ worker, exit, signal, receipt });
    });
  })));
  const after = kernelRecords([`--after-cursor=${baseline.__CURSOR}`]);
  const tableFull = after.filter(record => /nf_conntrack:.*table full/i.test(String(record.MESSAGE)));
  if (tableFull.length) failures.push(`${tableFull.length} kernel conntrack table-full messages`);
  const leftovers = ownedContainers();
  if (leftovers.length) {
    failures.push(`${leftovers.length} owned containers remained after their workers exited`);
    command("podman", ["rm", "-f", ...leftovers]);
  }
  const finalOwnedContainers = ownedContainers().length;
  if (finalOwnedContainers) failures.push("owned container cleanup failed");
  const summary = {
    runId, workers, requestsPerWorker: requests, expectedLoadRequests: workers * requests,
    seconds, elapsedMs: Math.round(performance.now() - started), kernelLog: "journalctl -k",
    kernelRecords: after.length, tableFull: tableFull.length, finalOwnedContainers, results, failures,
  };
  console.log(JSON.stringify(summary));
  if (failures.length) throw new Error(`CONNTRACK_SOAK_FAILED: ${failures.join("; ")}`);
}

main().catch(error => {
  // A journal/read failure must also fail closed and clean this run only.
  try {
    const leftovers = ownedContainers();
    if (leftovers.length) command("podman", ["rm", "-f", ...leftovers]);
  } catch (cleanupError) { console.error(`Owned cleanup failed: ${cleanupError.message}`); }
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
