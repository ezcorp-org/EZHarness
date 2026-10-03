import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PodmanRunner, buildLimits, configuredRunnerDevices, executionLimits, filesDigest, startExecutionDevices } from "../src";
import { provision, source } from "./helpers";

/**
 * The host runner is configured with the local AMD device profile, exactly the
 * host-global list the plan forbids a factory start from inheriting. Every case
 * below states which devices that start is entitled to and observes what the
 * kernel actually gave the guest, from the host's own `/dev` listing inside it.
 */
const HOST_DEVICES = ["/dev/kfd", "/dev/dri/renderD128", "/dev/dri/renderD129"] as const;
const REPORT_DEVICES = `async () => { const fs = require("node:fs"); return { kfd: fs.existsSync("/dev/kfd"), dri: fs.existsSync("/dev/dri") ? fs.readdirSync("/dev/dri").sort() : null, dev: fs.readdirSync("/dev").sort() }; }`;

type DeviceReport = { kfd: boolean; dri: string[] | null; dev: string[] };

let root: string;
let runner: PodmanRunner;
let artifactDigest: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ez-runner-devices-"));
  runner = new PodmanRunner({ root, configuredDevices: HOST_DEVICES, ...await provision() });
  await runner.initialize();
  const files = source(REPORT_DEVICES);
  const build = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(build.diagnostics).toEqual([]);
  expect(build.state).toBe("succeeded");
  artifactDigest = build.artifactDigest!;
}, 300_000);
afterAll(async () => { await runner.close(); await rm(root, { recursive: true, force: true }); });

async function report(devices?: readonly string[]): Promise<DeviceReport> {
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: "tenant-devices", scopeId: "project-devices", token: "device-token", deadline: Date.now() + 60_000 };
  const worker = await runner.start({ workerId, artifactDigest, context, limits: executionLimits, ...(devices === undefined ? {} : { devices }) }, async () => { throw new Error("a device probe never reaches the broker"); });
  try { return await worker.request("extension/invoke", { name: "echo", input: {}, context }) as DeviceReport; }
  finally { await worker.close(); }
}

test("the host runner really does hold the local AMD device profile", () => {
  expect(configuredRunnerDevices(HOST_DEVICES)).toEqual(HOST_DEVICES);
  expect(startExecutionDevices(undefined, HOST_DEVICES)).toEqual(HOST_DEVICES);
  expect(startExecutionDevices([], HOST_DEVICES)).toEqual([]);
  expect(startExecutionDevices(["/dev/kfd"], HOST_DEVICES)).toEqual(["/dev/kfd"]);
  expect(() => startExecutionDevices(["/dev/mem"], HOST_DEVICES)).toThrow("Runner device configuration is invalid");
});

test("a CPU factory start sees no GPU device although the host runner configures three", async () => {
  const observed = await report([]);
  expect(observed.kfd).toBe(false);
  expect(observed.dri).toBeNull();
  expect(observed.dev).not.toContain("kfd");
  expect(observed.dev).not.toContain("dri");
}, 180_000);

/**
 * The controlled fault: if the start had inherited the host list rather than its
 * own empty one, the very same guest would report every configured device. This
 * is the legacy v4 path, which is required to keep that behaviour.
 */
test("a v4 start that names no devices still receives the host configuration", async () => {
  const observed = await report();
  expect(observed.kfd).toBe(true);
  expect(observed.dri).toEqual(["renderD128", "renderD129"]);
}, 180_000);

test("a factory start receives exactly the devices its grant names and nothing else", async () => {
  const observed = await report(["/dev/dri/renderD128"]);
  expect(observed.kfd).toBe(false);
  expect(observed.dri).toEqual(["renderD128"]);
}, 180_000);

test("a build guest is denied a device even though the host configures three", async () => {
  const files = source(`async () => ({ built: true })`);
  files["device.test.ts"] = `import {test,expect} from 'bun:test';import fs from 'node:fs';test('a build guest has no GPU device',()=>{expect(fs.existsSync('/dev/kfd')).toBe(false);expect(fs.existsSync('/dev/dri')).toBe(false)});`;
  delete files["feature.test.ts"];
  const build = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(build.diagnostics).toEqual([]);
  expect(build.state).toBe("succeeded");
  expect(build.evidence.tests.map(entry => entry.name)).toContain("feature:device.test.ts");
}, 300_000);

test("a start whose grant names a device outside the runner profile never launches", async () => {
  await expect(report(["/dev/mem"])).rejects.toThrow("Runner device configuration is invalid");
  await expect(report(Array.from({ length: 17 }, (_value, index) => `/dev/dri/renderD${128 + index}`))).rejects.toThrow("Runner device configuration is invalid");
}, 120_000);
