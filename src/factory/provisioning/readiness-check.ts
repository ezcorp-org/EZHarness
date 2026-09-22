/**
 * The container health check every factory service in the Compose profile runs.
 *
 * Three forms, one exit contract (0 healthy, 1 not):
 *
 *   readiness-check.ts <file>              a published readiness record says `ready`
 *   readiness-check.ts --tcp <host:port>   a listener accepts a connection
 *   readiness-check.ts --http <url>        an HTTP endpoint answers 200
 *
 * A readiness record is the process's own statement about itself; this reads
 * it the way the product reads it — the lifecycle field — and never trusts the
 * container runtime's opinion that a process merely exists.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FactoryReadinessCheckDependencies {
  readonly readFile: (path: string) => Promise<string>;
  readonly connect: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  readonly fetchStatus: (url: string, timeoutMs: number) => Promise<number>;
}

const TIMEOUT_MS = 4_000;

export async function factoryReadinessCheck(argv: readonly string[], dependencies: FactoryReadinessCheckDependencies): Promise<boolean> {
  const [mode, target] = argv;
  try {
    if (mode === "--tcp" && target && argv.length === 2) {
      const separator = target.lastIndexOf(":");
      const port = Number(target.slice(separator + 1));
      if (separator < 1 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return false;
      return await dependencies.connect(target.slice(0, separator), port, TIMEOUT_MS);
    }
    if (mode === "--http" && target && argv.length === 2) return (await dependencies.fetchStatus(target, TIMEOUT_MS)) === 200;
    if (mode && argv.length === 1 && !mode.startsWith("--")) {
      const record = JSON.parse(await dependencies.readFile(mode)) as { lifecycle?: unknown };
      return record.lifecycle === "ready";
    }
    return false;
  } catch { return false; }
}

export const factoryReadinessCheckDependencies: FactoryReadinessCheckDependencies = {
  readFile: (path) => readFile(path, "utf8"),
  connect: (host, port, timeoutMs) => new Promise((settle) => {
    const socket = connect({ host, port });
    const done = (value: boolean) => { socket.destroy(); settle(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  }),
  fetchStatus: async (url, timeoutMs) => (await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" })).status,
};

const exitProcess = (code: number): void => process.exit(code);

export async function startFactoryReadinessCheck(argv: readonly string[], moduleUrl: string, exit: (code: number) => void = exitProcess, dependencies = factoryReadinessCheckDependencies): Promise<void> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return;
  exit(await factoryReadinessCheck(argv.slice(2), dependencies) ? 0 : 1);
}

void startFactoryReadinessCheck(process.argv, import.meta.url);
