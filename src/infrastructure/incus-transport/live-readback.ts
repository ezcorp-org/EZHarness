import { createHash, X509Certificate } from "node:crypto";
import type { SandboxCompatibilityObservation, SandboxPreset } from "@ezcorp/extension-contract";
import type { IncusSetupRecipe } from "../../../scripts/incus/model";
import { metadata, resourceName, withSession } from "./lifecycle";
import { object, verifiedHttpsRequest, type HostConnectionResolver, type HostConnectionScope,
  type PinnedFetch } from "./transport";
import { IncusTransportError, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";

type ReadbackScope = { installationId: string; releaseId: string; connectionId: string };
type ReadbackConnection = { revision: number; project: string; serverCertificatePem: string;
  configuration: { profile: string; guestUser: string; helperVersion: string } };

export interface LiveReadbackContext {
  scope: ReadbackScope;
  connection: ReadbackConnection;
  preset: SandboxPreset;
  presetDigest: string;
  effectiveSettingsDigest: string;
  recipe: IncusSetupRecipe;
}

export interface LiveBackendImage {
  observation: SandboxCompatibilityObservation;
  imageDigest: string;
  helperDigest: string;
  profile: string;
}

export interface LiveBackendInstance {
  state: "running" | "stopped" | "absent";
  imageDigest?: string;
  profile?: string;
  memoryBytes?: number;
  cpuMillis?: number;
  pids?: number;
  diskBytes?: number;
  storageDriver?: string;
  privateNetwork?: boolean;
  restrictedProject?: boolean;
  unprivileged?: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new IncusTransportError("permission", `Incus live backend readback failed: ${message}`);
}

function integer(value: unknown, label: string): number {
  assert(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `${label} is unavailable`);
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, `${label} is invalid`);
  return parsed;
}

function command(context: LiveReadbackContext, sandboxId?: string): IncusTransportRequest {
  const { scope, connection, preset, presetDigest, effectiveSettingsDigest } = context;
  const certificate = new X509Certificate(connection.serverCertificatePem);
  return { action: sandboxId ? "instance.inspect" : "instance.list", connectionId: scope.connectionId,
    deadlineMs: Date.now() + 30_000,
    pins: { connectionId: scope.connectionId,
      serverCertificateSha256: createHash("sha256").update(certificate.raw).digest("hex"),
      project: connection.project, profile: connection.configuration.profile,
      helperVersion: connection.configuration.helperVersion, guestUser: connection.configuration.guestUser },
    tags: { managedBy: "ezharness-incus-sandbox", connectionId: scope.connectionId,
      ...(sandboxId ? { sandboxId } : {}) },
    ...(sandboxId ? { sandboxName: resourceName(scope.connectionId, sandboxId) } : {}),
    payload: { providerId: "incus", profile: preset.profile, presetId: preset.id,
      presetDigest, effectiveSettingsDigest, allocate: false },
  };
}

function policy(context: LiveReadbackContext): HostConnectionScope {
  const { scope, connection, preset, presetDigest, effectiveSettingsDigest, recipe } = context;
  assert(recipe.guestImage?.fingerprint === preset.imageDigest && recipe.profile.name === connection.configuration.profile,
    "reviewed image or profile changed");
  return { providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    revision: connection.revision,
    approvedPreset: { profile: preset.profile, incusProfile: recipe.profile.name, presetId: preset.id,
      presetDigest, effectiveSettingsDigest, imageFingerprint: preset.imageDigest,
      limits: preset.limits } };
}

/** Only GETs over the same pinned mTLS session as lifecycle transport. */
export class HostIncusLiveReadback {
  constructor(private readonly connections: HostConnectionResolver,
    private readonly http: PinnedFetch = verifiedHttpsRequest) {}

  async image(context: LiveReadbackContext): Promise<LiveBackendImage> {
    const image = context.recipe.guestImage;
    assert(image?.fingerprint === context.preset.imageDigest && typeof image.alias === "string"
      && context.preset.helperDigests.includes(image.helperSha256), "reviewed image or helper changed");
    const fingerprint = context.preset.imageDigest;
    return withSession(this.connections, policy(context), this.http, command(context), async session => {
      const project = encodeURIComponent(session.connection.project);
      const imageRow = object(metadata(await session.request("GET",
        `/1.0/images/${fingerprint}?project=${project}`)));
      const aliases = imageRow.aliases;
      assert(imageRow.fingerprint === fingerprint && imageRow.type === "container"
        && Array.isArray(aliases) && aliases.some(alias => object(alias).name === image.alias),
      "backend image fingerprint, type, or alias changed");
      const server = object(metadata(await session.request("GET", `/1.0/?project=${project}`)));
      const environment = object(server.environment);
      const architecture = environment.kernel_architecture === "x86_64" ? "amd64"
        : environment.kernel_architecture === "aarch64" ? "arm64" : null;
      assert(server.api_version === "1.0" && typeof environment.server_version === "string"
        && architecture, "backend version or architecture changed");
      const pool = object(metadata(await session.request("GET",
        `/1.0/storage-pools/${encodeURIComponent(context.recipe.storage.name)}?project=${project}`)));
      assert(pool.name === context.recipe.storage.name && pool.driver === context.recipe.storage.driver,
        "backend storage driver changed");
      const profile = object(metadata(await session.request("GET",
        `/1.0/profiles/${encodeURIComponent(context.recipe.profile.name)}?project=${project}`)));
      assert(profile.name === context.recipe.profile.name, "backend profile changed");
      const observation: SandboxCompatibilityObservation = { backendApi: "incus.v1",
        backendVersion: environment.server_version as string, architecture,
        storageDriver: pool.driver as string, isolation: "container",
        nestedCompose: !!image.dockerArchiveSha256 && !!image.composeSha256 };
      return { observation, imageDigest: fingerprint, helperDigest: image.helperSha256,
        profile: context.preset.profile };
    });
  }

  async instance(context: LiveReadbackContext, sandboxId: string): Promise<LiveBackendInstance> {
    assert(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sandboxId), "invalid fixture identity");
    return withSession(this.connections, policy(context), this.http, command(context, sandboxId), async session => {
      const project = encodeURIComponent(session.connection.project);
      const path = `/1.0/instances/${resourceName(context.scope.connectionId, sandboxId)}?project=${project}`;
      const found = metadata(await session.request("GET", path), true);
      if (!found) return { state: "absent" };
      const instance = object(found);
      const config = object(instance.config);
      const expanded = object(instance.expanded_config);
      const devices = object(instance.devices);
      const root = object(devices.root);
      const projectRow = object(metadata(await session.request("GET",
        `/1.0/projects/${project}`)));
      const projectConfig = object(projectRow.config);
      const pool = object(metadata(await session.request("GET",
        `/1.0/storage-pools/${encodeURIComponent(context.recipe.storage.name)}?project=${project}`)));
      const profiles = instance.profiles;
      assert(instance.name === resourceName(context.scope.connectionId, sandboxId)
        && instance.type === "container" && ["Running", "Stopped"].includes(String(instance.status))
        && config["user.ezharness.managed_by"] === "ezharness-incus-sandbox"
        && config["user.ezharness.connection_id"] === context.scope.connectionId
        && config["user.ezharness.sandbox_id"] === sandboxId
        && config["user.ezharness.profile"] === context.preset.profile
        && config["user.ezharness.preset_id"] === context.preset.id
        && config["volatile.base_image"] === context.preset.imageDigest
        && Array.isArray(profiles) && profiles.includes(context.recipe.profile.name)
        && root.type === "disk" && root.path === "/" && root.pool === context.recipe.storage.name
        && pool.driver === context.recipe.storage.driver,
      "backend fixture identity or image changed");
      const memoryBytes = integer(config["limits.memory"], "memory limit");
      const cpuPlacement = integer(config["limits.cpu"], "CPU placement");
      const cpuAllowance = config["limits.cpu.allowance"];
      assert(cpuPlacement === Math.ceil(context.preset.limits.cpuMillis / 1000)
        && cpuAllowance === `${context.preset.limits.cpuMillis}ms/1000ms`,
      "backend fixture hard CPU allowance changed");
      const cpuMillis = context.preset.limits.cpuMillis;
      const pids = integer(config["limits.processes"], "PID limit");
      const diskBytes = integer(root.size, "root quota");
      assert(memoryBytes <= context.preset.limits.memoryBytes && cpuMillis <= context.preset.limits.cpuMillis
        && pids <= context.preset.limits.pids && diskBytes <= context.preset.limits.diskBytes,
      "backend fixture limits changed");
      const nic = object(object(instance.expanded_devices).eth0);
      return { state: instance.status === "Running" ? "running" : "stopped",
        imageDigest: context.preset.imageDigest, profile: context.preset.profile,
        memoryBytes, cpuMillis, pids, diskBytes, storageDriver: pool.driver as string,
        restrictedProject: projectRow.name === context.connection.project && projectConfig.restricted === "true",
        unprivileged: expanded["security.privileged"] === "false"
          && expanded["security.idmap.isolated"] === "true",
        privateNetwork: projectConfig["restricted.networks.access"] === context.recipe.network.name
          && nic.network === context.recipe.network.name && nic.type === "nic" };
    });
  }
}
