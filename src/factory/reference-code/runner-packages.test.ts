import { describe, expect, test } from "bun:test";
import { referenceCodeV1, type FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryGuestMaterialHost, factoryGuestStagedJson } from "../../__tests__/helpers/factory-guest-material-host";
import { unresolvedImports } from "../guest-sdk-closure";
import { REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { referenceCodeLaunchRepository } from "./fixtures";
import { REFERENCE_CODE_EXPORT_MANIFEST_NAMES, REFERENCE_CODE_IMPLEMENTATIONS, referenceCodeRunnerReferences } from "./pack";
import { REFERENCE_CODE_RUNNER_PACKAGES, referenceCodeRunnerPackageFiles } from "./runner-packages";
import {
  REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION,
  REFERENCE_CODE_RUNNER_TOOLS,
  REFERENCE_CODE_SNAPSHOT_OUTPUT,
  ReferenceCodeRunnerError,
  referenceCodeRecordedTree,
  referenceCodeRecordedTreeReader,
  referenceCodeSnapshotRunnerOutput,
} from "./runner-entry";
import { referenceCodeFilesFromWire, sealReferenceCodeSnapshot, snapshotReferenceCodeRepository } from "./snapshot";
import { factoryGitTreeId } from "../git-objects";

const COMMIT = "1".repeat(40);

describe("the reference-code runner packages the product installs (W4H-26)", () => {
  test("every REFERENCE_CODE_IMPLEMENTATIONS export is a tool of exactly the package the definition names", () => {
    const declared = REFERENCE_CODE_RUNNER_PACKAGES.flatMap(entry => entry.exports.map(exported => [exported, entry.manifestName] as const));
    expect(declared.map(([exported]): string => exported).sort()).toEqual(Object.keys(REFERENCE_CODE_IMPLEMENTATIONS).sort());
    for (const [exported, manifestName] of declared) expect(REFERENCE_CODE_EXPORT_MANIFEST_NAMES[exported]).toBe(manifestName);
    expect(Object.keys(REFERENCE_CODE_RUNNER_TOOLS).sort()).toEqual(Object.keys(REFERENCE_CODE_IMPLEMENTATIONS).sort());
  });

  test("each package's manifest name and version are the ones reference.code.v1's runner references bind to", () => {
    for (const reference of referenceCodeRunnerReferences(referenceCodeV1).filter(entry => entry.package.startsWith("@ezcorp/reference-code"))) {
      const entry = REFERENCE_CODE_RUNNER_PACKAGES.find(candidate => candidate.package === reference.package);
      expect(entry?.manifestName).toBe(reference.manifestName);
      expect(entry?.version).toBe(reference.version);
      expect(entry?.exports).toContain(reference.export as never);
    }
  });

  test("stages each package from committed source: an entry that declares its tools, and every import resolved inside", async () => {
    for (const entry of REFERENCE_CODE_RUNNER_PACKAGES) {
      const files = await referenceCodeRunnerPackageFiles(entry.manifestName);
      expect(unresolvedImports(files)).toEqual([]);
      const extension = files[REFERENCE_CODE_GUEST_ENTRYPOINT] as string;
      expect(extension).toContain("from '@ezcorp/sdk/v4'");
      expect(extension).toContain(`"name":"${entry.manifestName}"`);
      for (const exported of entry.exports) expect(extension).toContain(`"name":"${exported}"`);
      expect(files["runner-entry.ts"]).toContain('from "./snapshot.ts"');
      expect(files).toHaveProperty(["feature.test.ts"]);
    }
    expect(referenceCodeRunnerPackageFiles("not-a-package")).rejects.toThrow("reference_code_runner_package_unknown");
  });
});

describe("snapshotRepository in the guest, from a recorded tree", () => {
  const files = referenceCodeLaunchRepository();
  const treeSha = factoryGitTreeId(files.map(file => ({ path: file.path, mode: file.mode, content: file.content })));
  const connection = referenceCodeRecordedTree({ commitSha: COMMIT, treeSha, files });

  test("the recorded tree reads back exactly the product snapshot a host reader would take", async () => {
    const reader = referenceCodeRecordedTreeReader(connection);
    const snapshot = await snapshotReferenceCodeRepository(reader, COMMIT);
    const expected = sealReferenceCodeSnapshot({ baseSha: COMMIT, treeSha, entries: files.map(file => ({ path: file.path, mode: file.mode, content: file.content })) });
    expect(snapshot).toEqual(expected);
    const output = referenceCodeSnapshotRunnerOutput(snapshot) as { files: { path: string; mode: "100644" | "100755"; contentBase64: string }[]; digest: string };
    expect(referenceCodeFilesFromWire(output.files)).toEqual([...snapshot.files]);
    expect(output.digest).toBe(snapshot.digest);
  });

  test("a recorded tree answers only the commit it records", async () => {
    await expect(referenceCodeRecordedTreeReader(connection).resolveCommit("2".repeat(40))).rejects.toThrow("reference_code_base_commit_unknown");
    await expect(referenceCodeRecordedTreeReader(connection).readTree("2".repeat(40))).rejects.toThrow("reference_code_base_commit_unknown");
  });

  test("a recorded tree whose bytes are not the tree it names is refused, since the guest recomputes the tree id", async () => {
    const forged = referenceCodeRecordedTree({ commitSha: COMMIT, treeSha: "3".repeat(40), files });
    await expect(referenceCodeRecordedTreeReader(forged).resolveCommit(COMMIT)).rejects.toThrow("reference_code_recorded_tree_mismatch");
  });

  test("a connection that is not a recorded tree (a live GitHub connection) is refused by name", () => {
    for (const value of [{ provider: "github", repository: "o/r" }, null, "x", { ...connection, schemaVersion: "other" }, { ...connection, files: "x" }, { ...connection, files: [{ path: "a", mode: "100644" }] }, { ...connection, commitSha: 1 }]) {
      expect(() => referenceCodeRecordedTreeReader(value)).toThrow("reference_code_repository_reader_unavailable");
    }
    expect(connection.schemaVersion).toBe(REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION);
  });

  test("the tool completes with the snapshot as its staged output and no operation rows", async () => {
    const host = factoryGuestMaterialHost();
    const request = { authority: { runId: "run", nodeInstanceId: "snapshot-repository", candidateGeneration: 0, nextOperationIndex: 0 }, input: { kind: "inline", value: { repositoryConnection: connection, baseCommitSha: COMMIT } } } as unknown as FactoryRunnerRequest;
    const result = await REFERENCE_CODE_RUNNER_TOOLS.snapshotRepository(request, host.call);
    expect(result).toMatchObject({ status: "completed", journalCursor: -1, operations: [] });
    const snapshot = await snapshotReferenceCodeRepository(referenceCodeRecordedTreeReader(connection), COMMIT);
    expect(factoryGuestStagedJson(host.stored, REFERENCE_CODE_SNAPSHOT_OUTPUT)).toEqual(referenceCodeSnapshotRunnerOutput(snapshot));
  });

  test("an input that is not an inline object of bound ports is refused by name", async () => {
    for (const input of [{ kind: "artifact" }, { kind: "inline", value: null }, { kind: "inline", value: [] }, { kind: "inline", value: { repositoryConnection: connection, baseCommitSha: 7 } }]) {
      await expect(REFERENCE_CODE_RUNNER_TOOLS.snapshotRepository({ input } as unknown as FactoryRunnerRequest, async () => null)).rejects.toThrow("reference_code_runner_input_invalid");
    }
  });
});

describe("the exports a guest cannot run yet", () => {
  test("each refuses by name, naming the capability the later package adds", async () => {
    for (const exported of ["generateCandidate", "freezeGitTree", "protectedChecks", "supervisedReview"] as const) {
      const refused = REFERENCE_CODE_RUNNER_TOOLS[exported]({} as FactoryRunnerRequest, async () => null);
      await expect(refused).rejects.toBeInstanceOf(ReferenceCodeRunnerError);
      await expect(REFERENCE_CODE_RUNNER_TOOLS[exported]({} as FactoryRunnerRequest, async () => null)).rejects.toThrow(`reference_code_runner_pending: ${exported}`);
    }
  });
});
