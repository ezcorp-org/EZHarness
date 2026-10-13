import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FACTORY_SERVICE_BASE_ENVIRONMENT } from "../src/factory/provisioning/deployment";
import {
  FACTORY_SHIPPED_REPLAY_OK,
  FACTORY_SHIPPED_TEMPLATE,
  checkFactoryImageShippedConfig,
  factoryShippedIsolationArguments,
  factoryShippedReplayCommand,
  factoryShippedServiceArguments,
  startFactoryImageShippedConfigCheck,
} from "./check-factory-image-shipped-config";

const IDS = { uid: 1001, gid: 100 };
const REPOSITORY = resolve(import.meta.dir, "..");
let scratch = "";
beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), "shipped-config-")); });
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

describe("the shipped isolation, read from installation.yml and the deployer", () => {
  test("the orchestrator runs keep-id as the deployer's user, read-only, with the noexec /tmp, no new privileges, no capabilities, and the deployer's HOME", async () => {
    const shipped = Bun.YAML.parse(await Bun.file(FACTORY_SHIPPED_TEMPLATE).text()) as { services: Record<string, Record<string, unknown>> };
    const args = await factoryShippedServiceArguments("orchestrator", IDS);
    expect([...args].sort()).toEqual([
      "--cap-drop=ALL", "--env=HOME=/tmp", "--read-only", "--security-opt=no-new-privileges:true",
      `--tmpfs=${(shipped.services.orchestrator!.tmpfs as string[])[0]}`, "--user=1001:100", "--userns=keep-id",
    ].sort());
    expect(args).toContain("--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m");
    expect(args.filter((arg) => arg.startsWith("--env="))).toEqual(Object.entries(FACTORY_SERVICE_BASE_ENVIRONMENT.orchestrator).map(([key, value]) => `--env=${key}=${value}`));
  });

  test("every installation service gets the same isolation; each its own HOME", async () => {
    const isolation = (args: string[]) => args.filter((arg) => !arg.startsWith("--env="));
    const orchestrator = await factoryShippedServiceArguments("orchestrator", IDS);
    for (const service of ["gateway", "harness"] as const) {
      const args = await factoryShippedServiceArguments(service, IDS);
      expect(isolation(args)).toEqual(isolation(orchestrator));
      expect(args).toContain(`--env=HOME=${FACTORY_SERVICE_BASE_ENVIRONMENT[service].HOME}`);
    }
  });

  test("each isolation key maps to its flag; a writable root maps to none; keys that do not isolate are ignored", () => {
    const service = { image: "x", command: ["node"], volumes: [], read_only: true, tmpfs: ["/tmp:rw,noexec"], cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], userns_mode: "keep-id", user: `\${EZCORP_FACTORY_UID:?}:\${EZCORP_FACTORY_GID:?}` };
    expect(factoryShippedIsolationArguments(service, IDS)).toEqual(["--read-only", "--tmpfs=/tmp:rw,noexec", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--userns=keep-id", "--user=1001:100"]);
    expect(factoryShippedIsolationArguments({ read_only: false }, IDS)).toEqual([]);
  });

  test("a key the guard cannot apply, a variable it does not render, or a malformed list is a refusal, never a skipped flag", async () => {
    expect(() => factoryShippedIsolationArguments({ cap_add: ["NET_ADMIN"] }, IDS)).toThrow("installation.yml sets cap_add, which this guard cannot apply");
    expect(() => factoryShippedIsolationArguments({ user: `\${OTHER}` }, IDS)).toThrow("names a variable this guard does not render");
    expect(() => factoryShippedIsolationArguments({ tmpfs: "/tmp" }, IDS)).toThrow("installation.yml tmpfs is not a list of strings");
    const template = join(scratch, "installation.yml");
    await writeFile(template, "services:\n  gateway:\n    read_only: true\n");
    await expect(factoryShippedServiceArguments("orchestrator", IDS, template)).rejects.toThrow("installation.yml has no orchestrator service");
  });
});

describe("the replay run", () => {
  test("no network, the shipped flags, the replay program and the committed history mounted read-only, the image's own node", () => {
    expect(factoryShippedReplayCommand("img@sha256:1", ["--read-only"])).toEqual([
      "podman", "run", "--rm", "--network=none", "--read-only",
      `--volume=${REPOSITORY}/scripts/factory-image-replay-check.mjs:/run/ezcorp-check/replay.mjs:ro`,
      `--volume=${REPOSITORY}/packages/@ezcorp/factory-orchestrator/test/fixtures/factory-workflow-history.json:/run/ezcorp-check/history.json:ro`,
      "--entrypoint=node", "img@sha256:1", "/run/ezcorp-check/replay.mjs", "/app", "/run/ezcorp-check/history.json",
    ]);
  });

  test("passes only when the image replays with its build-time bundle", async () => {
    const seen: (readonly string[])[] = [];
    const answer = (code: number, output: string) => async (command: readonly string[]) => { seen.push(command); return { code, output }; };
    expect((await checkFactoryImageShippedConfig("img", answer(0, `${FACTORY_SHIPPED_REPLAY_OK}\n`), IDS)).ok).toBe(true);
    expect(seen[0]).toContain("--read-only");
    expect(seen[0]).toContain("--env=HOME=/tmp");
    for (const [code, output] of [[0, "REPLAY OK: runtime bundle\n"], [1, `${FACTORY_SHIPPED_REPLAY_OK}\n`], [1, "Error: Failed to load native binding\n"]] as const) {
      expect((await checkFactoryImageShippedConfig("img", answer(code, output), IDS)).ok).toBe(false);
    }
  });

  test("the replay program replays the committed history with this tree's build-time bundle", async () => {
    const build = Bun.spawnSync(["node", "--experimental-strip-types", "packages/@ezcorp/factory-orchestrator/src/workflow-bundle-build.ts"], { cwd: REPOSITORY });
    expect(build.exitCode).toBe(0);
    const run = Bun.spawnSync(["node", "scripts/factory-image-replay-check.mjs", REPOSITORY, "packages/@ezcorp/factory-orchestrator/test/fixtures/factory-workflow-history.json"], { cwd: REPOSITORY });
    expect(new TextDecoder().decode(run.stdout).trim()).toBe(FACTORY_SHIPPED_REPLAY_OK);
    expect(run.exitCode).toBe(0);
  }, 120_000);
});

describe("the entry", () => {
  const script = `${REPOSITORY}/scripts/check-factory-image-shipped-config.ts`;
  test("runs only as the process entry, needs an image, and exits by the result", async () => {
    const lines: string[] = [];
    const print = (line: string) => { lines.push(line); };
    const check = (ok: boolean) => async () => ({ ok, command: ["podman", "run"], output: "line\n" });
    expect(await startFactoryImageShippedConfigCheck(["bun"], pathToFileURL(script).href, check(true), print)).toBeUndefined();
    expect(await startFactoryImageShippedConfigCheck(["bun", script], pathToFileURL(script).href, check(true), print)).toBe(2);
    expect(await startFactoryImageShippedConfigCheck(["bun", script, "img"], pathToFileURL(script).href, check(true), print)).toBe(0);
    expect(await startFactoryImageShippedConfigCheck(["bun", script, "img"], pathToFileURL(script).href, check(false), print)).toBe(1);
    expect(lines).toEqual(["usage: bun scripts/check-factory-image-shipped-config.ts <image>", "shipped-config PASS: podman run", "line", "shipped-config FAIL: podman run", "line"]);
  });
});
