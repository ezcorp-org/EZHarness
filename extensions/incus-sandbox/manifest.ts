import {
  SANDBOX_PROVIDER_OPERATIONS,
  sandboxProviderMethodSchemas,
  validateManifest,
  type ExtensionManifestV4,
  type SandboxPreset,
  type SandboxProfileId,
  type SandboxProviderCapability,
  type SandboxProtocolMethodGroup,
  type SandboxProtocolOperation,
} from "@ezcorp/extension-contract";
import { INCUS_CONNECTION_CONFIG_SCHEMA } from "./config";

export const INCUS_PROVIDER_ID = "incus";
export const INCUS_PROFILES: SandboxProfileId[] = ["linux-exec.v1", "persistent-web-compose.v1"];
export const INCUS_CAPABILITIES: SandboxProviderCapability[] = [
  "lifecycle.v1",
  "files.v1",
  "processes.v1",
  "endpoints.v1",
];

export const INCUS_METHOD_GROUP: SandboxProtocolMethodGroup = {
  name: "sandbox.provider.v1",
  methods: {
    describe: "incus/describe",
    preflight: "incus/preflight",
    lifecycle: {
      create: "incus/lifecycle/create",
      inspect: "incus/lifecycle/inspect",
      list: "incus/lifecycle/list",
      setPower: "incus/lifecycle/setPower",
      destroy: "incus/lifecycle/destroy",
      inspectOperation: "incus/lifecycle/inspectOperation",
    },
    files: {
      stat: "incus/files/stat",
      list: "incus/files/list",
      readRange: "incus/files/readRange",
      writeAtomic: "incus/files/writeAtomic",
      remove: "incus/files/remove",
    },
    processes: {
      start: "incus/processes/start",
      inspect: "incus/processes/inspect",
      readOutput: "incus/processes/readOutput",
      cancel: "incus/processes/cancel",
    },
    endpoints: {
      open: "incus/endpoints/open",
      close: "incus/endpoints/close",
    },
  },
};

export function incusMethodName(operation: SandboxProtocolOperation): string {
  if (operation === "describe" || operation === "preflight") {
    return INCUS_METHOD_GROUP.methods[operation];
  }
  const [group, name] = operation.split(".") as [
    "lifecycle" | "files" | "processes" | "endpoints",
    string,
  ];
  const methods = INCUS_METHOD_GROUP.methods[group] as unknown as Record<string, string>;
  return methods[name]!;
}

const commonPreset: Omit<SandboxPreset, "id" | "profile" | "recipeDigest" | "storage"> = {
  imageDigest: "f1cfb02e245d196ab3b6175027289ff2ae1c7cd5e47137e2ed063302a2d67d32",
  helperDigests: ["adf03619fffd352fcb1bbb7b765c38e8e687aa71d3a723c38f5c56f8758940f3"],
  network: { mode: "private", outbound: "restricted" },
  limits: {
    memoryBytes: 4_294_967_296,
    cpuMillis: 2_000,
    pids: 1_024,
    diskBytes: 21_474_836_480,
    timeoutMs: 3_600_000,
  },
  allowedOverrides: {
    memoryBytes: { minimum: 1_073_741_824, maximum: 17_179_869_184 },
    cpuMillis: { minimum: 500, maximum: 8_000 },
    pids: { minimum: 256, maximum: 4_096 },
    diskBytes: { minimum: 5_368_709_120, maximum: 107_374_182_400 },
    timeoutMs: { minimum: 60_000, maximum: 86_400_000 },
  },
  requirements: {
    backendApis: ["incus.v1"],
    architectures: ["amd64"],
    storageDrivers: ["zfs", "btrfs"],
    isolation: ["container"],
    nestedCompose: false,
  },
};

export const INCUS_PRESETS: SandboxPreset[] = [
  {
    ...commonPreset,
    id: "incus-linux-exec-v1",
    profile: "linux-exec.v1",
    recipeDigest: "0d19e5fcd94daa78edad71ad034525db3335692768174c42da1da101ef0e2953",
    storage: { workspace: "ephemeral", minimumBytes: 5_368_709_120 },
  },
  {
    ...commonPreset,
    id: "incus-compose-v1",
    profile: "persistent-web-compose.v1",
    recipeDigest: "9025ecd64f8d0a85ecdef4567f34102468854568a800308275036afc21ac44e6",
    storage: { workspace: "persistent", minimumBytes: 5_368_709_120 },
    requirements: { ...commonPreset.requirements, nestedCompose: true },
  },
];

export const incusManifest: ExtensionManifestV4 = validateManifest({
  schemaVersion: 4,
  name: "incus-sandbox",
  version: "0.1.0",
  description: "Incus sandbox provider over the host-owned protected transport.",
  author: { name: "EZCorp" },
  entrypoint: "./extension.ts",
  permissions: {},
  methods: SANDBOX_PROVIDER_OPERATIONS.map((operation) => ({
    name: incusMethodName(operation),
    ...sandboxProviderMethodSchemas(operation),
  })),
  sandboxProviders: [
    {
      id: INCUS_PROVIDER_ID,
      profiles: INCUS_PROFILES,
      presets: INCUS_PRESETS,
      capabilities: INCUS_CAPABILITIES,
      kind: "sandbox",
      protocolMajor: 1,
      minimumHostContract: { major: 4, minor: 0 },
      configSchema: INCUS_CONNECTION_CONFIG_SCHEMA,
      requiredPermissions: [],
      methodGroups: [INCUS_METHOD_GROUP],
    },
  ],
});
