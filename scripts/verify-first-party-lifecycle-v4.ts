import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { PodmanRunner, provisionToolchain, buildLimits, resolveDependencies } from "@ezcorp/extension-runner";
import type { CandidateVerificationReport } from "@ezcorp/extension-contract";
import { up } from "../src/db/migrations/add-extension-releases";
import { DatabaseLifecycleRepository } from "../src/db/queries/extension-releases";
import { verifyExtensionCandidate } from "../src/extensions/extension-lifecycle-service";
import type { CandidateFixtures } from "../src/extensions/candidate-verification-broker";
import { ExtensionLifecycle, FileBlobStore } from "../src/extensions/v4";
import { listFirstPartyExtensionSources, snapshotFirstPartyExtension } from "./migrate-extension-v4";

export interface FirstPartyLifecycleEvidence {
  name: string;
  state: "verified" | "failed";
  sourceDigest?: string;
  artifactDigest?: string;
  releaseDigest?: string;
  verification?: CandidateVerificationReport;
  diagnostics?: unknown;
  failure?: unknown;
}

export async function verifyFirstPartyLifecycle(options: { projectRoot: string; names?: string[]; fixtures?: Record<string, CandidateFixtures>; emit(record: FirstPartyLifecycleEvidence): void; failFast?: boolean }): Promise<{ total: number; passed: number; failed: number; untested: number }> {
  const allSources = await listFirstPartyExtensionSources(options.projectRoot);
  const sources = options.names ? allSources.filter((source) => options.names!.includes(source.name)) : allSources;
  if (!sources.length || options.names?.some((name) => !sources.some((source) => source.name === name))) throw new Error("Verification selection contains unknown extensions");
  const directory = await mkdtemp(join(tmpdir(), "extension-lifecycle-parity-"));
  const database = new PGlite(join(directory, "database"));
  let runner: PodmanRunner | undefined;
  let passed = 0;
  let failed = 0;
  try {
    runner = new PodmanRunner({ root: join(directory, "runner"), ...await provisionToolchain({ sdkEntrypoint: join(options.projectRoot, "packages/@ezcorp/sdk/src/v4/index.ts") }) });
    await runner.initialize();
    const activeRunner = runner;
    const driver = drizzle(database);
    await up(driver);
    const lifecycle = new ExtensionLifecycle({
      repository: new DatabaseLifecycleRepository(driver), blobs: new FileBlobStore(join(directory, "blobs")), runner,
      runnerProfile: "rootless-podman-v4", runnerImageDigest: runner.image, validatorVersion: "runner-v4.1", buildLimits,
      authorize: async () => {},
      verifyCandidate: (release) => verifyExtensionCandidate(activeRunner, release, undefined, options.fixtures?.[release.manifest.name]),
      publish: async () => { throw new Error("Parity builds must never activate extensions"); },
    });
    const actor = { principalId: "extension-verification", scope: "global", kind: "service" as const };
    for (const source of sources) {
      const record: FirstPartyLifecycleEvidence = { name: source.name, state: "failed" };
      try {
        const snapshot = await snapshotFirstPartyExtension(options.projectRoot, source.name);
        const created = await lifecycle.createWorkspace(actor, { files: snapshot.files });
        let revision = created.workspace.revision;
        if (snapshot.files["package.json"]) {
          const resolved = await resolveDependencies(snapshot.files);
          const writes = Object.fromEntries(Object.entries(resolved).filter(([path, value]) => snapshot.files[path] !== value));
          if (Object.keys(writes).length) revision = (await lifecycle.editWorkspace(actor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: revision, writes })).revision;
        }
        const operation = await lifecycle.build(actor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: revision, idempotencyKey: "parity-build", entrypoint: source.entrypoint });
        record.sourceDigest = operation.sourceDigest;
        const result = await lifecycle.runBuild(actor, created.installation.id, operation.id);
        record.diagnostics = result.diagnostics;
        if (result.state !== "verified" || !result.releaseId) throw Object.assign(new Error("Lifecycle candidate build failed"), { operation: result });
        const state = await lifecycle.inspect(actor, created.installation.id);
        const release = state.releases[result.releaseId]!;
        if (state.installation.enabled || state.installation.activeReleaseId) throw new Error("Verification unexpectedly activated an extension");
        record.state = "verified";
        record.artifactDigest = release.artifactDigest;
        record.releaseDigest = release.releaseDigest;
        record.verification = release.verification;
        passed++;
      } catch (error) {
        record.failure = error && typeof error === "object" ? { message: error instanceof Error ? error.message : "Verification failed", ...error } : { message: String(error) };
        failed++;
      }
      options.emit(record);
      if (record.state === "failed" && options.failFast !== false) break;
    }
    return { total: sources.length, passed, failed, untested: sources.length - passed - failed };
  } finally { try { await runner?.close(); } finally { try { await database.close(); } finally { await rm(directory, { recursive: true, force: true }); } } }
}

if (import.meta.main) {
  const fixturePath = process.env.EXTENSION_VERIFY_FIXTURES;
  const summary = await verifyFirstPartyLifecycle({
    projectRoot: resolve(import.meta.dirname, ".."),
    names: process.env.EXTENSION_VERIFY_NAMES?.split(","),
    fixtures: fixturePath ? await Bun.file(fixturePath).json() : undefined,
    failFast: process.env.EXTENSION_VERIFY_ALL !== "1",
    emit: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  });
  process.stdout.write(`${JSON.stringify({ summary })}\n`);
  if (summary.failed || summary.untested) process.exitCode = 1;
}
