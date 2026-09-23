import { afterAll, expect, test } from "bun:test";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../../extensions/incus-sandbox/manifest";
import recipeValue from "../../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../../scripts/incus/model";
import { HostIncusLiveReadback, type LiveReadbackContext } from "./live-readback";
import { resourceName } from "./lifecycle";
import { makeTestCertificates } from "./test-certificates";

const certs = makeTestCertificates();
afterAll(() => certs.dispose());
const recipe = recipeValue as IncusSetupRecipe;
const connectionId = "connection-a";
const sandboxId = "binding-a";
const name = resourceName(connectionId, sandboxId);
const connection = { endpoint: "https://127.0.0.1:8443", serverCertificatePem: certs.read("server-cert.pem"),
  project: recipe.project.name, clientCertificatePem: certs.read("client-cert.pem"),
  privateKeyPem: certs.read("client-key.pem") };
const envelope = (metadata: unknown, status = 200) => Response.json({ type: "sync", status_code: status, metadata }, { status });

async function context(): Promise<LiveReadbackContext> {
  const preset = INCUS_PRESETS[0]!;
  return { scope: { installationId: "installation-a", releaseId: "release-a", connectionId },
    connection: { revision: 1, project: recipe.project.name,
      serverCertificatePem: connection.serverCertificatePem,
      configuration: { profile: recipe.profile.name, helperVersion: "0.1.0", guestUser: "sandbox" } },
    preset, presetDigest: await sandboxPresetDigest(preset), effectiveSettingsDigest: "a".repeat(64), recipe };
}

function backend(instance?: Record<string, unknown>, imageFingerprint = recipe.guestImage!.fingerprint,
  profileDevices: unknown = recipe.profile.devices) {
  const paths: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.startsWith("/1.0/images/")) return envelope({ fingerprint: imageFingerprint,
      type: "container", aliases: [{ name: recipe.guestImage!.alias }] });
    if (path === "/1.0/") return envelope({ api_version: "1.0", environment: {
      kernel_architecture: "x86_64", server_version: "6.0.6" } });
    if (path.startsWith("/1.0/storage-pools/")) return envelope({ name: recipe.storage.name,
      driver: recipe.storage.driver });
    if (path.startsWith("/1.0/profiles/")) return envelope({ name: recipe.profile.name, devices: profileDevices });
    if (path.startsWith("/1.0/projects/")) return envelope({ name: recipe.project.name,
      config: recipe.project.config });
    if (path.startsWith("/1.0/instances/")) return instance ? envelope(instance) : envelope({}, 404);
    throw new Error(`unexpected backend route ${path}`);
  };
  return { value: new HostIncusLiveReadback({ resolveForHost: async () => connection }, fetcher as never), paths };
}

function instanceRecord(image = recipe.guestImage!.fingerprint) {
  const preset = INCUS_PRESETS[0]!;
  return { name, type: "container", status: "Stopped", profiles: [recipe.profile.name],
    config: { "user.ezharness.managed_by": "ezharness-incus-sandbox",
      "user.ezharness.connection_id": connectionId, "user.ezharness.sandbox_id": sandboxId,
      "user.ezharness.profile": preset.profile, "user.ezharness.preset_id": preset.id,
      "volatile.base_image": image, "limits.memory": String(preset.limits.memoryBytes),
      "limits.cpu": String(preset.limits.cpuMillis / 1000),
      "limits.cpu.allowance": `${preset.limits.cpuMillis}ms/1000ms`,
      "limits.processes": String(preset.limits.pids) },
    expanded_config: { "security.privileged": "false", "security.idmap.isolated": "true" },
    expanded_devices: { eth0: { type: "nic", network: recipe.network.name, "security.port_isolation": "true" },
      root: recipe.profile.devices.root },
    devices: { root: { type: "disk", path: "/", pool: recipe.storage.name,
      size: String(preset.limits.diskBytes) } } };
}

test("pinned readback checks exact image inventory and instance resource state", async () => {
  const selected = await context();
  const host = backend(instanceRecord());
  const observed = await host.value.image(selected);
  expect(observed.imageDigest).toBe(selected.preset.imageDigest);
  expect(observed.helperDigest).toBe(recipe.guestImage!.helperSha256);
  const fixture = await host.value.instance(selected, sandboxId);
  expect(fixture).toMatchObject({ state: "stopped", imageDigest: selected.preset.imageDigest,
    storageDriver: recipe.storage.driver, privateNetwork: true, restrictedProject: true, unprivileged: true });
  expect(host.paths).toContain(`/1.0/instances/${name}`);
});

test("wrong project, forged image, and altered limits deny readback", async () => {
  const selected = await context();
  const wrongProject = new HostIncusLiveReadback({ resolveForHost: async () => ({ ...connection, project: "other" }) },
    (async () => { throw new Error("must not send HTTP"); }) as never);
  await expect(wrongProject.image(selected)).rejects.toThrow("project pin");
  await expect(backend(undefined, "f".repeat(64)).value.image(selected))
    .rejects.toThrow("backend image fingerprint");
  await expect(backend(undefined, selected.preset.imageDigest, { eth0: {
    ...recipe.profile.devices.eth0, "security.port_isolation": "false" } }).value.image(selected))
    .rejects.toThrow("feature devices changed");
  await expect(backend(undefined, selected.preset.imageDigest, { ...recipe.profile.devices,
    eth0: { ...recipe.profile.devices.eth0, "security.port_isolation": "false" } }).value.image(selected))
    .rejects.toThrow("feature NIC isolation changed");
  await expect(backend(instanceRecord("f".repeat(64))).value.instance(selected, sandboxId))
    .rejects.toThrow("fixture identity or image changed");
  const overLimit = instanceRecord();
  overLimit.config["limits.memory"] = String(selected.preset.limits.memoryBytes + 1);
  await expect(backend(overLimit).value.instance(selected, sandboxId))
    .rejects.toThrow("fixture limits changed");
  const missingHardLimit = instanceRecord();
  delete (missingHardLimit.config as Record<string, string>)["limits.cpu.allowance"];
  await expect(backend(missingHardLimit).value.instance(selected, sandboxId))
    .rejects.toThrow("hard CPU allowance changed");
  const relaxedHardLimit = instanceRecord();
  relaxedHardLimit.config["limits.cpu.allowance"] = "3000ms/1000ms";
  await expect(backend(relaxedHardLimit).value.instance(selected, sandboxId))
    .rejects.toThrow("hard CPU allowance changed");
  const unisolatedNic = instanceRecord();
  (unisolatedNic.expanded_devices.eth0 as Record<string, string>)["security.port_isolation"] = "false";
  await expect(backend(unisolatedNic).value.instance(selected, sandboxId))
    .rejects.toThrow("fixture NIC isolation changed");
  const extraNic = instanceRecord();
  (extraNic.expanded_devices as Record<string, unknown>).eth1 = { type: "nic", name: "eth1", network: "unsafe" };
  await expect(backend(extraNic).value.instance(selected, sandboxId))
    .rejects.toThrow("fixture devices changed");
});

test("fractional CPU reservation reads the hard allowance, not rounded CPU placement", async () => {
  const selected = await context();
  selected.preset = { ...selected.preset,
    limits: { ...selected.preset.limits, cpuMillis: 1500 } };
  const instance = instanceRecord();
  instance.config["limits.cpu"] = "2";
  instance.config["limits.cpu.allowance"] = "1500ms/1000ms";
  const observed = await backend(instance).value.instance(selected, sandboxId);
  expect(observed.cpuMillis).toBe(1500);
});
