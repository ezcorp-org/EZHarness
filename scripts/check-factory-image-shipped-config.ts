#!/usr/bin/env bun
/**
 * The shipped-isolation guard (W4H-27): does the factory image's orchestrator get its workflow code
 * and run it under the isolation the Compose profile SHIPS?
 *
 *   bun scripts/check-factory-image-shipped-config.ts <image>
 *
 * The isolation is read from deploy/factory/compose/installation.yml and the environment from the
 * deployer's own `FACTORY_SERVICE_BASE_ENVIRONMENT`, never restated here: a proof that ran on a
 * container the product does not ship proved nothing (the W16 G7 pass ran a plain native addon; the
 * 1.16.13 carrier that later needed an executable user cache was never started under these flags).
 * A service key this guard does not know how to apply is a refusal, so a new isolation key cannot be
 * silently skipped. The image replays a committed workflow history with its build-time bundle
 * (scripts/factory-image-replay-check.mjs); exit 0 only for "REPLAY OK: build-time bundle".
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_SERVICE_BASE_ENVIRONMENT, type FactoryDeployedService } from "../src/factory/provisioning/deployment";

const REPOSITORY = resolve(import.meta.dir, "..");
export const FACTORY_SHIPPED_TEMPLATE = resolve(REPOSITORY, "deploy/factory/compose/installation.yml");
const CHECK_DIRECTORY = "/run/ezcorp-check";
const REPLAY_PROGRAM = resolve(REPOSITORY, "scripts/factory-image-replay-check.mjs");
const HISTORY = resolve(REPOSITORY, "packages/@ezcorp/factory-orchestrator/test/fixtures/factory-workflow-history.json");
export const FACTORY_SHIPPED_REPLAY_OK = "REPLAY OK: build-time bundle";

/** Service keys that do not change what the process may do inside its container. Every other key must map to a flag. */
const NOT_ISOLATION = new Set(["image", "network_mode", "ports", "command", "env_file", "depends_on", "volumes", "healthcheck", "restart", "stop_grace_period", "labels", "mem_limit", "cpus", "pids_limit"]);

const list = (key: string, value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`installation.yml ${key} is not a list of strings`);
  return value;
};

/** The `podman run` flags one rendered service's isolation keys mean, with the user rendered as the deployer renders it. */
export function factoryShippedIsolationArguments(service: Readonly<Record<string, unknown>>, ids: { readonly uid: number; readonly gid: number }): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(service)) {
    if (NOT_ISOLATION.has(key)) continue;
    if (key === "userns_mode") args.push(`--userns=${String(value)}`);
    else if (key === "user") {
      const user = String(value).replace(/\$\{EZCORP_FACTORY_UID:\?\}/, String(ids.uid)).replace(/\$\{EZCORP_FACTORY_GID:\?\}/, String(ids.gid));
      if (user.includes("$")) throw new Error(`installation.yml user ${String(value)} names a variable this guard does not render`);
      args.push(`--user=${user}`);
    } else if (key === "read_only") { if (value === true) args.push("--read-only"); }
    else if (key === "tmpfs") args.push(...list(key, value).map((entry) => `--tmpfs=${entry}`));
    else if (key === "security_opt") args.push(...list(key, value).map((entry) => `--security-opt=${entry}`));
    else if (key === "cap_drop") args.push(...list(key, value).map((entry) => `--cap-drop=${entry}`));
    else throw new Error(`installation.yml sets ${key}, which this guard cannot apply; teach the guard before shipping the key`);
  }
  return args;
}

/** One service's shipped isolation and base environment, read from the template and the deployer. */
export async function factoryShippedServiceArguments(service: FactoryDeployedService, ids: { readonly uid: number; readonly gid: number }, template = FACTORY_SHIPPED_TEMPLATE): Promise<string[]> {
  const parsed = Bun.YAML.parse(await Bun.file(template).text()) as { services?: Record<string, Record<string, unknown>> };
  const definition = parsed.services?.[service];
  if (!definition) throw new Error(`installation.yml has no ${service} service`);
  return [...factoryShippedIsolationArguments(definition, ids), ...Object.entries(FACTORY_SERVICE_BASE_ENVIRONMENT[service]).map(([key, value]) => `--env=${key}=${value}`)];
}

/** The container run: no network, the shipped flags, the replay program and the history mounted read-only. */
export function factoryShippedReplayCommand(image: string, shipped: readonly string[]): string[] {
  return [
    "podman", "run", "--rm", "--network=none", ...shipped,
    `--volume=${REPLAY_PROGRAM}:${CHECK_DIRECTORY}/replay.mjs:ro`, `--volume=${HISTORY}:${CHECK_DIRECTORY}/history.json:ro`,
    "--entrypoint=node", image, `${CHECK_DIRECTORY}/replay.mjs`, "/app", `${CHECK_DIRECTORY}/history.json`,
  ];
}

export type FactoryCommandRun = (command: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>;

const spawnRun: FactoryCommandRun = async (command) => {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: `${stdout}${stderr}` };
};

/** Run the orchestrator's workflow path in `image` under the shipped isolation. */
export async function checkFactoryImageShippedConfig(image: string, run: FactoryCommandRun = spawnRun, ids = { uid: process.getuid!(), gid: process.getgid!() }): Promise<{ readonly ok: boolean; readonly command: readonly string[]; readonly output: string }> {
  const command = factoryShippedReplayCommand(image, await factoryShippedServiceArguments("orchestrator", ids));
  const result = await run(command);
  return { ok: result.code === 0 && result.output.split("\n").includes(FACTORY_SHIPPED_REPLAY_OK), command, output: result.output };
}

export async function startFactoryImageShippedConfigCheck(argv: readonly string[], moduleUrl: string, check: typeof checkFactoryImageShippedConfig = checkFactoryImageShippedConfig, print: (line: string) => void = console.log): Promise<number | undefined> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return undefined;
  if (!argv[2]) { print("usage: bun scripts/check-factory-image-shipped-config.ts <image>"); return 2; }
  const result = await check(argv[2]);
  print(`shipped-config ${result.ok ? "PASS" : "FAIL"}: ${result.command.join(" ")}`);
  print(result.output.trim().split("\n").slice(-60).join("\n"));
  return result.ok ? 0 : 1;
}

const exit = await startFactoryImageShippedConfigCheck(process.argv, import.meta.url);
if (exit !== undefined) process.exit(exit);
