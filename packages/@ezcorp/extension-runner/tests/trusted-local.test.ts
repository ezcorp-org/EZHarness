import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildLimits, executionLimits, filesDigest, TrustedLocalRunner, TRUSTED_LOCAL_OMITTED_CONTROLS } from "../src";
import { sha256 } from "../src/core";
import { provision, source } from "./helpers";

test("trusted-local requires an exact admin approval, audit and separate execution approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-trusted-local-"));
  const files = source();
  const sourceDigest = filesDigest(files);
  let allowed = "";
  let audited = 0;
  const runner = new TrustedLocalRunner({ root, ...await provision(), bunPath: process.execPath, bunDigest: sha256(await readFile(process.execPath)), dedicatedUid: process.getuid!(), approvalFor: async (phase, digest) => digest === allowed ? { phase, digest, approvedBy: "human-admin", expiresAt: Date.now() + 30_000, omittedControls: [...TRUSTED_LOCAL_OMITTED_CONTROLS] } : null, audit: async () => { audited++; } });
  try {
    await expect(runner.build({ operationId: randomUUID(), files, sourceDigest, entrypoint: "extension.ts", limits: buildLimits })).rejects.toThrow("Admin approval");
    allowed = sourceDigest;
    const result = await runner.build({ operationId: randomUUID(), files, sourceDigest, entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    expect(result.imageDigest).toContain("trusted-local");
    expect(audited).toBe(1);
    const workerId = randomUUID();
    const context = { workerId, invocationId: randomUUID(), releaseId: result.artifactDigest!, principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 10_000 };
    await expect(runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => null)).rejects.toThrow("Admin approval");
    allowed = result.artifactDigest!;
    const worker = await runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => null);
    try { expect(await worker.request("extension/invoke", { name: "echo", input: { message: "trusted" }, context })).toEqual({ message: "trusted" }); } finally { await worker.close(); }
    expect(audited).toBe(2);
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
