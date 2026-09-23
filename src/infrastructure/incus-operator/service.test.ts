import { expect, test } from "bun:test";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { incusManifest } from "../../../extensions/incus-sandbox/manifest";
import checkedInRecipe from "../../../scripts/incus/recipe.json";
import imageBuildTemplate from "../../../scripts/incus/recipe.template.json";
import type { RemoteRunner } from "../../../scripts/incus/inspect";
import type { IncusInventory, IncusSetupRecipe } from "../../../scripts/incus/model";
import { up as addExtensionReleases } from "../../db/migrations/add-extension-releases";
import { up as addProviderConnections } from "../../db/migrations/add-provider-connections";
import { up as addIncusOperatorSetups } from "../../db/migrations/add-incus-operator-setups";
import { releaseRuntimeFixture } from "../../__tests__/helpers/release-runtime";
import { ProviderConnectionStore } from "../provider-connections/store";
import { IncusOperatorSetupService, bootstrapFromEnvironment, loadReviewedIncusRecipe } from "./service";
import { issueIncusClientIdentity } from "./identity";

const certificatePem = readFileSync(new URL("../incus-transport/test-server.pem", import.meta.url), "utf8");
const certificateFingerprint = createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex");
const clientPem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";
const bootstrap = { ssh: { sshTarget: "dev@sandbox-server", sshIdentityFile: "/host/key", sshKnownHostsFile: "/host/known_hosts",
  sshHostKeySha256: `SHA256:${"A".repeat(43)}` }, endpoint: "https://incus.example:8443" };
const guestImage = checkedInRecipe.guestImage;
const recipe: IncusSetupRecipe = {
  ...checkedInRecipe, expected: { ...checkedInRecipe.expected, serverCertificateFingerprint: certificateFingerprint,
    sshHostKeySha256: bootstrap.ssh.sshHostKeySha256 },
  guestImage,
} as IncusSetupRecipe;

function inventory(): IncusInventory {
  return { schemaVersion: 1, capturedAt: new Date().toISOString(), connection: { sshTarget: bootstrap.ssh.sshTarget, sshHostKeySha256: bootstrap.ssh.sshHostKeySha256 },
    host: { hostname: "sandbox-server", os: "NixOS", kernel: "6.12", architecture: "x86_64", cpuThreads: 12,
      memoryBytes: 64 * 1024 ** 3, rootFreeBytes: 210 * 1024 ** 3, addresses: ["100.81.181.39"], cgroupVersion: "v2", ntpSynchronized: true },
    server: { clientVersion: "6.0.6", serverVersion: "6.0.6", certificateFingerprint, certificatePem,
      apiStatus: "stable", clustered: false, firewall: "nftables", serviceActive: true,
      apiExtensions: [...recipe.expected.requiredApiExtensions], storageDrivers: [{ name: "btrfs", version: "6", remote: false }], httpsAddresses: [] },
    routes: [], projects: [], storagePools: [], networks: [], profiles: [], instances: [], trust: [],
    images: [{ fingerprint: guestImage.fingerprint, aliases: [guestImage.alias] }] };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "incus-operator-"));
  const client = new PGlite(directory);
  await client.waitReady;
  const db = drizzle(client);
  await addExtensionReleases(db);
  await addProviderConnections(db);
  await addIncusOperatorSetups(db);
  const { snapshot } = releaseRuntimeFixture("incus-installation", incusManifest);
  snapshot.installation.generation = 2;
  snapshot.installation.acknowledgedGeneration = 2;
  await client.query("INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES ($1,$2,$3,$4)",
    [snapshot.installation.id, snapshot.installation.ownerId, "global", JSON.stringify(snapshot.installation)]);
  await client.query("INSERT INTO extension_release_records (installation_id,kind,id,payload) VALUES ($1,'releases',$2,$3)",
    [snapshot.installation.id, snapshot.release.id, JSON.stringify(snapshot.release)]);
  await client.query("INSERT INTO extension_release_records (installation_id,kind,id,payload) VALUES ($1,'approvals',$2,$3)",
    [snapshot.installation.id, "approval", JSON.stringify({ id: "approval", installationId: snapshot.installation.id, releaseId: snapshot.release.id,
      releaseDigest: snapshot.release.releaseDigest, principalId: snapshot.installation.ownerId, scope: "global", status: "consumed", expectedGeneration: 1 })]);
  let observed = inventory();
  const calls: string[][] = [];
  let run: RemoteRunner = async () => ({ exitCode: 1, stdout: "", stderr: "connection reset" });
  let probeFails = true;
  const connections = new ProviderConnectionStore(db);
  const service = new IncusOperatorSetupService({ database: db, connections, bootstrap, recipe,
    activeRelease: async () => snapshot, inspect: async () => structuredClone(observed),
    identity: async () => ({ certificatePem: clientPem, privateKeyPem: "secret-private-key-canary", fingerprint: "b".repeat(64) }),
    runner: () => async (argv, stdin) => { calls.push([...argv]); return run(argv, stdin); },
    process: () => ({ callIncusProbe: async () => {
      if (probeFails) throw new Error("probe unavailable");
      return { jsonrpc: "2.0", id: "probe", result: { ok: true } };
    } }),
  });
  return { directory, client, db, service, connections, snapshot, calls,
    setRunner(next: RemoteRunner) { run = next; },
    allowProbe() { probeFails = false; },
    observe(value: IncusInventory) { observed = value; },
    async close() { await client.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("host setup requires only host-owned bootstrap fields", () => {
  expect(bootstrapFromEnvironment({})).toBeNull();
  const loaded = bootstrapFromEnvironment({ EZCORP_INCUS_SETUP_SSH_TARGET: bootstrap.ssh.sshTarget,
    EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE: bootstrap.ssh.sshIdentityFile,
    EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE: bootstrap.ssh.sshKnownHostsFile,
    EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256: bootstrap.ssh.sshHostKeySha256,
    EZCORP_INCUS_SETUP_ENDPOINT: bootstrap.endpoint });
  expect(loaded).toEqual(bootstrap);
  expect(() => bootstrapFromEnvironment({ EZCORP_INCUS_SETUP_SSH_TARGET: bootstrap.ssh.sshTarget,
    EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE: bootstrap.ssh.sshIdentityFile,
    EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE: bootstrap.ssh.sshKnownHostsFile,
    EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256: bootstrap.ssh.sshHostKeySha256,
    EZCORP_INCUS_SETUP_ENDPOINT: "http://sandbox-server:8443" })).toThrow();
});

test("host-owned setup recipe must pin the image and cannot be swapped through a link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incus-reviewed-recipe-"));
  const path = join(directory, "recipe.json");
  try {
    writeFileSync(path, JSON.stringify(recipe), { mode: 0o600 });
    expect(loadReviewedIncusRecipe(path).guestImage?.fingerprint).toBe(guestImage.fingerprint);
    expect(() => loadReviewedIncusRecipe("relative/recipe.json")).toThrow("absolute");
    expect(() => loadReviewedIncusRecipe(join(directory, "missing.json"))).toThrow("cannot be opened");
    const link = join(directory, "linked.json");
    symlinkSync(path, link);
    expect(() => loadReviewedIncusRecipe(link)).toThrow("cannot be opened");
    chmodSync(path, 0o666);
    expect(() => loadReviewedIncusRecipe(path)).toThrow("operator-owned");
    chmodSync(path, 0o600);
    writeFileSync(path, "not json");
    expect(() => loadReviewedIncusRecipe(path)).toThrow("not valid JSON");
    writeFileSync(path, JSON.stringify(imageBuildTemplate));
    expect(() => loadReviewedIncusRecipe(path)).toThrow("must pin the image");
    const supplied = await issueIncusClientIdentity("injected");
    writeFileSync(path, JSON.stringify({ ...recipe, providerClient: { name: "engine",
      certificateFingerprint: supplied.fingerprint, certificatePem: supplied.certificatePem,
      projects: [recipe.project.name], restricted: true } }));
    expect(() => loadReviewedIncusRecipe(path)).toThrow("leave client identity to the engine");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("issued client certificate and private key form one scoped identity", async () => {
  const identity = await issueIncusClientIdentity("test-connection");
  const certificate = new X509Certificate(identity.certificatePem);
  expect(identity.fingerprint).toBe(certificate.fingerprint256.replaceAll(":", "").toLowerCase());
  expect(Buffer.from(certificate.publicKey.export({ type: "spki", format: "der" }))).toEqual(
    Buffer.from(createPublicKey(identity.privateKeyPem).export({ type: "spki", format: "der" })));
  expect(identity.certificatePem).not.toContain(identity.privateKeyPem);
});

test("a saved review binds the approved release and never exposes the private key", async () => {
  const value = await fixture();
  try {
    const setup = await value.service.plan(value.snapshot.installation.id, "admin");
    expect(setup.state).toBe("planned");
    expect(setup.plan.status).toBe("ready");
    expect(setup.plan.steps.find(step => step.id === "profile-device-eth0")?.apply.argv).toContain("security.port_isolation=true");
    expect(JSON.stringify(setup)).not.toContain("secret-private-key-canary");
    expect(JSON.stringify(await value.service.latest(value.snapshot.installation.id))).not.toContain("secret-private-key-canary");
    await expect(value.service.apply(setup.id, "a".repeat(64), "admin")).rejects.toThrow("exact ready plan digest");
    expect((await value.service.latest(value.snapshot.installation.id))?.state).toBe("planned");
    value.snapshot.installation.generation++;
    await expect(value.service.apply(setup.id, setup.plan.planDigest, "admin")).rejects.toThrow("provider release changed");
  } finally { await value.close(); }
}, 30_000);

test("a newer saved plan replaces the old review before any SSH effect", async () => {
  const value = await fixture();
  try {
    const oldPlan = await value.service.plan(value.snapshot.installation.id, "admin");
    const newPlan = await value.service.plan(value.snapshot.installation.id, "admin");
    expect(newPlan.id).not.toBe(oldPlan.id);
    await expect(value.service.apply(oldPlan.id, oldPlan.plan.planDigest, "admin"))
      .rejects.toThrow("replaced by a newer plan");
    expect(value.calls).toHaveLength(0);
    expect((await value.service.latest(value.snapshot.installation.id))?.id).toBe(newPlan.id);
  } finally { await value.close(); }
}, 30_000);

test("the database admits only one SSH apply per provider installation", async () => {
  const value = await fixture();
  try {
    const first = await value.service.plan(value.snapshot.installation.id, "admin");
    const second = await value.service.plan(value.snapshot.installation.id, "admin");
    await value.client.query("UPDATE incus_operator_setups SET state = 'applying' WHERE id = $1", [first.id]);
    await expect(value.client.query("UPDATE incus_operator_setups SET state = 'applying' WHERE id = $1", [second.id]))
      .rejects.toThrow();
  } finally { await value.close(); }
}, 30_000);

test("unknown SSH outcome is durable and a repeated review does not duplicate a known effect", async () => {
  const value = await fixture();
  try {
    const setup = await value.service.plan(value.snapshot.installation.id, "admin");
    const result = await value.service.apply(setup.id, setup.plan.planDigest, "admin");
    expect(result.state).toBe("reconcile_required");
    expect(result.receipt?.state).toBe("reconcile_required");
    expect(result.receipt?.steps[0]?.id).toBe("storage-pool");
    expect((await value.service.latest(value.snapshot.installation.id))?.state).toBe("reconcile_required");
    const firstStep = setup.plan.steps[0]!;
    value.setRunner(async argv => {
      if (argv.join("\0") === firstStep.inspect.argv.join("\0")) return { exitCode: 0, stdout: JSON.stringify(firstStep.inspect.expected), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "connection reset" };
    });
    const retry = await value.service.apply(setup.id, setup.plan.planDigest, "admin");
    expect(retry.receipt?.steps[0]?.action).toBe("skipped");
    expect(value.calls.filter(argv => argv.join("\0") === firstStep.apply.argv.join("\0"))).toHaveLength(1);
  } finally { await value.close(); }
}, 30_000);

test("reviewed plan applies each step once, verifies the server, and cannot run twice", async () => {
  const value = await fixture();
  try {
    const setup = await value.service.plan(value.snapshot.installation.id, "admin");
    const applied = new Set<string>();
    const expected = (id: string) => setup.plan.steps.find(step => step.id === id)!.inspect.expected;
    value.setRunner(async argv => {
      const key = argv.join("\0");
      const inspection = setup.plan.steps.find(step => step.inspect.argv.join("\0") === key);
      if (inspection) {
        if (!applied.has(inspection.id)) return { exitCode: inspection.inspect.emptyAsAbsent ? 0 : 1, stdout: "", stderr: "" };
        const result = inspection.inspect.expected;
        return { exitCode: 0, stdout: typeof result === "string" ? result : JSON.stringify(result), stderr: "" };
      }
      const mutation = setup.plan.steps.find(step => step.apply.argv.join("\0") === key);
      if (!mutation) throw new Error("Unexpected SSH command");
      applied.add(mutation.id);
      if (applied.size === setup.plan.steps.length) {
        const current = inventory();
        value.observe({ ...current,
          host: { ...current.host, rootFreeBytes: current.host.rootFreeBytes - recipe.storage.sizeBytes },
          routes: ["10.173.0.0/24"], routeBindings: [{ destination: "10.173.0.0/24", device: recipe.network.name }],
          server: { ...current.server, httpsAddresses: [recipe.server.httpsAddress] },
          storagePools: [{ ...(expected("storage-pool") as object), description: "", status: "Created" } as IncusInventory["storagePools"][number]],
          networks: [{ ...(expected("managed-network") as object), description: "", status: "Created" } as IncusInventory["networks"][number]],
          projects: [expected("restricted-project") as IncusInventory["projects"][number]],
          profiles: [{ name: recipe.profile.name, project: recipe.project.name, description: recipe.profile.description,
            config: recipe.profile.config, devices: recipe.profile.devices }],
          trust: [expected("provider-client") as IncusInventory["trust"][number]] });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await value.service.apply(setup.id, setup.plan.planDigest, "admin");
    expect(result.state).toBe("verified");
    expect(result.receipt?.steps).toHaveLength(setup.plan.steps.length);
    expect(applied.size).toBe(setup.plan.steps.length);
    await expect(value.service.apply(setup.id, setup.plan.planDigest, "admin")).rejects.toThrow("has completed");
    expect((await value.service.latest(value.snapshot.installation.id))?.state).toBe("verified");
  } finally { await value.close(); }
}, 30_000);

test("a plan left applying by a prior engine process becomes a visible reconciliation task", async () => {
  const value = await fixture();
  try {
    const setup = await value.service.plan(value.snapshot.installation.id, "admin");
    await value.client.query("UPDATE incus_operator_setups SET state = 'applying', apply_token = 'old-process' WHERE id = $1", [setup.id]);
    const recovered = await value.service.latest(value.snapshot.installation.id);
    expect(recovered?.state).toBe("reconcile_required");
    expect(recovered?.failures?.[0]).toContain("restarted");
    expect(JSON.stringify(recovered)).not.toContain("old-process");
  } finally { await value.close(); }
}, 30_000);

test("provider probe requires verified setup and a failed probe does not change server state", async () => {
  const value = await fixture();
  try {
    const setup = await value.service.plan(value.snapshot.installation.id, "admin");
    await expect(value.service.probe(setup.id)).rejects.toThrow("Verify the reviewed server setup");
    await value.client.query("UPDATE incus_operator_setups SET state = 'verified' WHERE id = $1", [setup.id]);
    await expect(value.service.probe(setup.id)).rejects.toThrow("probe unavailable");
    expect((await value.service.latest(value.snapshot.installation.id))?.state).toBe("verified");
    value.allowProbe();
    const success = await value.service.probe(setup.id);
    expect(success.result).toMatchObject({ result: { ok: true } });
    expect(JSON.stringify(success)).not.toContain("secret-private-key-canary");
  } finally { await value.close(); }
}, 30_000);

test("client identity rejects unsafe connection identifiers before invoking OpenSSL", async () => {
  for (const id of ["", "../escape", "has space", "x".repeat(129)]) {
    await expect(issueIncusClientIdentity(id)).rejects.toThrow("Invalid Incus connection identity");
  }
});

test("operator plan rejects a released preset with an unreviewed image before SSH effects", async () => {
  const value = await fixture();
  try {
    const preset = value.snapshot.release.manifest.sandboxProviders?.find(provider => provider.id === "incus")?.presets[0];
    expect(preset).toBeDefined();
    preset!.imageDigest = "0".repeat(64);
    const setup = await value.service.plan(value.snapshot.installation.id, "admin");
    expect(setup.state).toBe("blocked");
    expect(setup.plan.blockedReasons).toContain(`preset_image_digest_mismatch:${preset!.id}`);
    expect(value.calls).toHaveLength(0);
  } finally { await value.close(); }
}, 30_000);

test("client identity reports unavailable and failed OpenSSL without exposing command output", async () => {
  const originalPath = process.env.PATH;
  const directory = await mkdtemp(join(tmpdir(), "incus-openssl-failure-"));
  try {
    process.env.PATH = directory;
    await expect(issueIncusClientIdentity("missing-openssl"))
      .rejects.toThrow("OpenSSL is required on the EZHarness engine host");
    await Bun.write(join(directory, "openssl"), "#!/bin/sh\nexit 2\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(directory, "openssl"), 0o755);
    await expect(issueIncusClientIdentity("failed-openssl"))
      .rejects.toThrow("Incus client identity generation failed");
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("client identity rejects a certificate paired with another private key", async () => {
  const originalPath = process.env.PATH;
  const directory = await mkdtemp(join(tmpdir(), "incus-openssl-mismatch-"));
  const otherKey = join(directory, "other.key");
  try {
    const { execFileSync } = await import("node:child_process");
    const realOpenSsl = Bun.which("openssl");
    const realCopy = Bun.which("cp");
    expect(realOpenSsl).not.toBeNull();
    expect(realCopy).not.toBeNull();
    execFileSync(realOpenSsl!, ["genpkey", "-algorithm", "EC", "-pkeyopt",
      "ec_paramgen_curve:P-256", "-out", otherKey]);
    await Bun.write(join(directory, "openssl"),
      "#!/bin/sh\nkey=\nprevious=\nfor arg in \"$@\"; do\n  if [ \"$previous\" = -keyout ]; then key=\"$arg\"; fi\n  previous=\"$arg\"\ndone\n\"$INCUS_REAL_OPENSSL\" \"$@\" || exit 1\n\"$INCUS_REAL_CP\" \"$INCUS_MISMATCH_KEY\" \"$key\"\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(directory, "openssl"), 0o755);
    process.env.INCUS_MISMATCH_KEY = otherKey;
    process.env.INCUS_REAL_OPENSSL = realOpenSsl!;
    process.env.INCUS_REAL_CP = realCopy!;
    process.env.PATH = directory;
    await expect(issueIncusClientIdentity("mismatched-certificate"))
      .rejects.toThrow("Incus client certificate and key do not match");
  } finally {
    process.env.PATH = originalPath;
    delete process.env.INCUS_MISMATCH_KEY;
    delete process.env.INCUS_REAL_OPENSSL;
    delete process.env.INCUS_REAL_CP;
    await rm(directory, { recursive: true, force: true });
  }
});
