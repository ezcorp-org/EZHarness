/**
 * GPU host profile registration for the pool (C05, C03; freeze section 6).
 *
 * W02 made a held `gpu-host` allocation authorize devices only through the
 * profile REGISTERED for the host that holds the lease
 * (`factoryHeldAllocationDevices`), and left the registry to W16. This is it:
 * the pool's operator declares, per GPU host the pool offers, exactly which
 * device nodes (the local AMD profile) or CDI device names (the production
 * NVIDIA profile) one whole-host allocation carries. Nothing else can put a
 * device into an attempt.
 *
 * Declaring a profile does NOT make a host production-ready. C05's production
 * GPU profile has eight criteria and this host meets none of them; each one is
 * a named readiness row with its own verdict (`FACTORY_PRODUCTION_GPU_CRITERIA`,
 * the same rows as docs/factory-local-gpu.md), and a profile that claims the
 * production tier without evidence for every row is refused.
 *
 * Wiring: the pool process loads `config.resources.gpuProfilesPath` with
 * `loadFactoryGpuHostProfiles` before its listener binds, so a bad or unproven
 * declaration keeps the pool degraded (`gpu_profiles_unavailable`). No lease
 * path consumes the registry yet: `factoryHeldAllocationDevices` has no
 * production caller, which the W16 gate file names.
 */
import { basename, dirname, resolve } from "node:path";
import { privateDirectory, readPrivateBounded } from "../private-files";
import { factoryAttemptDeviceGrant, type FactoryGpuHostProfile } from "../runner/attempt-wire";

export const FACTORY_GPU_HOST_PROFILES_SCHEMA = "factory.gpu-host-profiles.v1";

/** C05's production GPU criteria. A host is production-ready only with evidence for every one. */
export const FACTORY_PRODUCTION_GPU_CRITERIA = Object.freeze([
  "cdi-whole-gpu-injection",
  "tenant-dedicated-host",
  "no-host-plane-colocation",
  "supported-driver-toolkit-pair",
  "capabilities-limited-to-compute-utility",
  "device-reset-before-reuse",
  "verified-reimage-before-reassignment",
  "single-device-isolation",
] as const);
export type FactoryProductionGpuCriterion = typeof FACTORY_PRODUCTION_GPU_CRITERIA[number];

export interface FactoryGpuHostDeclaration {
  readonly hostId: string;
  /** `trusted-local`: one trusted local tenant only. `production`: requires evidence for every criterion. */
  readonly tier: "trusted-local" | "production";
  readonly devices: readonly string[];
  readonly cdiDevices: readonly string[];
  /** Criterion -> the path of the evidence that proves it. Required for every criterion at the production tier. */
  readonly evidence?: Readonly<Partial<Record<FactoryProductionGpuCriterion, string>>>;
}

export interface FactoryGpuReadinessRow {
  readonly hostId: string;
  readonly criterion: FactoryProductionGpuCriterion;
  readonly verdict: "met" | "unmet";
  readonly evidence: string | null;
}

export class FactoryGpuHostProfileError extends Error {
  constructor(readonly code: "gpu_profiles_invalid" | "gpu_profile_unknown_host" | "gpu_profile_duplicate" | "gpu_profile_devices_invalid" | "gpu_profile_unproven_production" | "gpu_profiles_unreadable") {
    super(code);
    this.name = "FactoryGpuHostProfileError";
  }
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Validate device nodes and CDI names with the SAME validator a launch grant uses: one allowlist, not two. */
function assertDevices(declaration: FactoryGpuHostDeclaration): void {
  try {
    factoryAttemptDeviceGrant("gpu-profile-validation", { reservationId: "validation", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "validation", hostId: declaration.hostId }, { gpuHosts: 1, devices: declaration.devices, cdiDevices: declaration.cdiDevices });
  } catch { throw new FactoryGpuHostProfileError("gpu_profile_devices_invalid"); }
}

export class FactoryGpuHostProfiles {
  private constructor(private readonly declarations: ReadonlyMap<string, FactoryGpuHostDeclaration>) {}

  /**
   * Register one profile per GPU host the pool offers. A profile for a host
   * the pool does not offer, a second profile for one host, a device outside
   * the shared allowlist, and an unproven production claim are all refused.
   * A GPU host with no profile stays unable to authorize any device.
   */
  static register(gpuHosts: readonly string[], value: unknown): FactoryGpuHostProfiles {
    const document = value as { schemaVersion?: unknown; hosts?: unknown } | null;
    if (!document || typeof document !== "object" || Object.keys(document).sort().join(",") !== "hosts,schemaVersion" || document.schemaVersion !== FACTORY_GPU_HOST_PROFILES_SCHEMA || !Array.isArray(document.hosts) || document.hosts.length > 10_000) throw new FactoryGpuHostProfileError("gpu_profiles_invalid");
    const offered = new Set(gpuHosts);
    const declarations = new Map<string, FactoryGpuHostDeclaration>();
    for (const entry of document.hosts as unknown[]) {
      const host = entry as Partial<FactoryGpuHostDeclaration> | null;
      const keys = host && typeof host === "object" ? Object.keys(host).sort().join(",") : "";
      if (!host || !["cdiDevices,devices,hostId,tier", "cdiDevices,devices,evidence,hostId,tier"].includes(keys) || typeof host.hostId !== "string" || !HOST.test(host.hostId)
        || (host.tier !== "trusted-local" && host.tier !== "production") || !Array.isArray(host.devices) || !Array.isArray(host.cdiDevices)) throw new FactoryGpuHostProfileError("gpu_profiles_invalid");
      if (!offered.has(host.hostId)) throw new FactoryGpuHostProfileError("gpu_profile_unknown_host");
      if (declarations.has(host.hostId)) throw new FactoryGpuHostProfileError("gpu_profile_duplicate");
      const declaration = Object.freeze({ hostId: host.hostId, tier: host.tier, devices: Object.freeze([...host.devices]), cdiDevices: Object.freeze([...host.cdiDevices]), ...(host.evidence ? { evidence: Object.freeze({ ...host.evidence }) } : {}) }) as FactoryGpuHostDeclaration;
      assertDevices(declaration);
      if (declaration.tier === "production" && FACTORY_PRODUCTION_GPU_CRITERIA.some((criterion) => typeof declaration.evidence?.[criterion] !== "string" || declaration.evidence[criterion]!.length === 0)) throw new FactoryGpuHostProfileError("gpu_profile_unproven_production");
      declarations.set(host.hostId, declaration);
    }
    return new FactoryGpuHostProfiles(declarations);
  }

  /** The profile `factoryHeldAllocationDevices` needs for the host holding a lease; undefined authorizes no device. */
  profile(hostId: string): FactoryGpuHostProfile | undefined {
    const declaration = this.declarations.get(hostId);
    return declaration ? Object.freeze({ hostId, devices: declaration.devices, cdiDevices: declaration.cdiDevices }) : undefined;
  }

  /** One named row per production criterion per host. A trusted-local host is unmet on every row by definition. */
  readiness(): readonly FactoryGpuReadinessRow[] {
    return Object.freeze([...this.declarations.values()].flatMap((declaration) => FACTORY_PRODUCTION_GPU_CRITERIA.map((criterion) => {
      const evidence = declaration.tier === "production" ? declaration.evidence![criterion]! : null;
      return Object.freeze({ hostId: declaration.hostId, criterion, verdict: evidence ? "met" as const : "unmet" as const, evidence });
    })));
  }

  /** Whether any declared host may take untrusted GPU work. False on this host: every profile is trusted-local. */
  productionReady(hostId: string): boolean {
    return this.declarations.get(hostId)?.tier === "production";
  }
}

/** Read a declaration file through the private reader and register it. */
export async function loadFactoryGpuHostProfiles(path: string, gpuHosts: readonly string[]): Promise<FactoryGpuHostProfiles> {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    const directory = await privateDirectory(dirname(absolute));
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, basename(absolute), 256 * 1024))); }
    finally { await directory.close(); }
  } catch { throw new FactoryGpuHostProfileError("gpu_profiles_unreadable"); }
  return FactoryGpuHostProfiles.register(gpuHosts, parsed);
}
