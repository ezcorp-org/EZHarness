import { describe, expect, test } from "bun:test";
import { referenceCodeV1, type FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { validateNodeOutput } from "@ezcorp/factory-sdk/kernel";
import { sha256Hex } from "@ezcorp/factory-sdk/canonical";
import { factoryGuestMaterialHost, factoryGuestStagedJson } from "../../__tests__/helpers/factory-guest-material-host";
import { unresolvedImports } from "../guest-sdk-closure";
import { REFERENCE_CODE_GUEST_ENTRYPOINT } from "./guest";
import { REFERENCE_CODE_ACCEPTED_SLUGIFY, REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS, REFERENCE_CODE_FIXTURE_POLICY, REFERENCE_CODE_FIXTURE_REQUEST, referenceCodeFixtureCandidate, referenceCodeLaunchRepository } from "./fixtures";
import { REFERENCE_CODE_EXPORT_MANIFEST_NAMES, REFERENCE_CODE_IMPLEMENTATIONS, referenceCodeRunnerReferences } from "./pack";
import { REFERENCE_CODE_RUNNER_PACKAGES, referenceCodeRunnerPackageFiles } from "./runner-packages";
import {
  REFERENCE_CODE_CANDIDATE_OUTPUT,
  REFERENCE_CODE_GENERATION_OUTPUT,
  REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION,
  REFERENCE_CODE_RUNNER_TOOLS,
  REFERENCE_CODE_RESULT_OUTPUT,
  REFERENCE_CODE_SNAPSHOT_OUTPUT,
  referenceCodeCandidateRunnerOutput,
  referenceCodeConnectionFacts,
  referenceCodeRecordedTree,
  referenceCodeRecordedTreeReader,
  referenceCodeS3Publication,
  referenceCodeSnapshotFromRunnerOutput,
  referenceCodeSnapshotRunnerOutput,
} from "./runner-entry";
import { REFERENCE_CODE_GUEST_MAX_OUTPUT_TOKENS } from "./guest-generate";
import { freezeReferenceCodeCandidate, referenceCodePullRequestTitle } from "./freeze";
import { assertFactoryGitHubPublicationRequest } from "../release-github-request";
import { assertFactoryS3AcceptedPublication } from "../release-s3-scope";
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
  const facts = { policy: REFERENCE_CODE_FIXTURE_POLICY, committedAtSeconds: REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS };
  const connection = referenceCodeRecordedTree({ commitSha: COMMIT, treeSha, files, ...facts });

  test("the recorded tree reads back exactly the product snapshot a host reader would take", async () => {
    const reader = referenceCodeRecordedTreeReader(connection);
    const snapshot = await snapshotReferenceCodeRepository(reader, COMMIT);
    const expected = sealReferenceCodeSnapshot({ baseSha: COMMIT, treeSha, entries: files.map(file => ({ path: file.path, mode: file.mode, content: file.content })) });
    expect(snapshot).toEqual(expected);
    const output = referenceCodeSnapshotRunnerOutput(snapshot, facts) as { files: { path: string; mode: "100644" | "100755"; contentBase64: string }[]; digest: string };
    expect(referenceCodeFilesFromWire(output.files)).toEqual([...snapshot.files]);
    expect(output.digest).toBe(snapshot.digest);
    // The output seals the connection's policy and time beside the tree, and reads back whole.
    const bytes = new TextEncoder().encode(JSON.stringify(output));
    expect(referenceCodeSnapshotFromRunnerOutput(bytes)).toEqual({ snapshot, ...facts });
  });

  test("a recorded tree answers only the commit it records", async () => {
    await expect(referenceCodeRecordedTreeReader(connection).resolveCommit("2".repeat(40))).rejects.toThrow("reference_code_base_commit_unknown");
    await expect(referenceCodeRecordedTreeReader(connection).readTree("2".repeat(40))).rejects.toThrow("reference_code_base_commit_unknown");
  });

  test("a recorded tree whose bytes are not the tree it names is refused, since the guest recomputes the tree id", async () => {
    const forged = referenceCodeRecordedTree({ commitSha: COMMIT, treeSha: "3".repeat(40), files, ...facts });
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
    expect(factoryGuestStagedJson(host.stored, REFERENCE_CODE_SNAPSHOT_OUTPUT)).toEqual(referenceCodeSnapshotRunnerOutput(snapshot, facts));
    // The node's `snapshot` port: an artifact reference to the sealed snapshot, valid against the definition's port schema.
    const port = factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { snapshot: { digest: string; mediaType: string; storage: string } };
    expect(port.snapshot).toEqual({ digest: `sha256:${sha256Hex(host.stored.get(REFERENCE_CODE_SNAPSHOT_OUTPUT)!)}`, mediaType: "application/json", storage: expect.stringMatching(/^object-/) });
    const node = referenceCodeV1.graph.nodes.find(candidate => candidate.id === "snapshot-repository")!;
    expect(validateNodeOutput(node, port as never)).toBe(true);
  });

  test("an input that is not an inline object of bound ports is refused by name", async () => {
    for (const input of [{ kind: "artifact" }, { kind: "inline", value: null }, { kind: "inline", value: [] }, { kind: "inline", value: { repositoryConnection: connection, baseCommitSha: 7 } }]) {
      await expect(REFERENCE_CODE_RUNNER_TOOLS.snapshotRepository({ input } as unknown as FactoryRunnerRequest, async () => null)).rejects.toThrow("reference_code_runner_input_invalid");
    }
  });
});

describe("a connection states its policy and its base commit's time (W4H-28)", () => {
  const facts = { policy: REFERENCE_CODE_FIXTURE_POLICY, committedAtSeconds: REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS };
  test("both facts are required, and the policy is checked field by field", () => {
    expect(referenceCodeConnectionFacts(facts)).toEqual(facts);
    for (const broken of [null, {}, { ...facts, committedAtSeconds: -1 }, { ...facts, committedAtSeconds: 1.5 }]) {
      expect(() => referenceCodeConnectionFacts(broken)).toThrow("reference_code_runner_input_invalid");
    }
    for (const policy of [null, [], { ...facts.policy, repositoryId: 0 }, { ...facts.policy, allowedPaths: [] }, { ...facts.policy, protectedPaths: "x" }, { ...facts.policy, protectedTestPaths: [""] }]) {
      expect(() => referenceCodeConnectionFacts({ ...facts, policy })).toThrow("reference_code_policy_invalid");
    }
  });

  test("a snapshot output whose digest is not its files', or that is not a snapshot, is refused", () => {
    const snapshot = sealReferenceCodeSnapshot({ baseSha: COMMIT, treeSha: "4".repeat(40), entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode, content: file.content })) });
    const output = referenceCodeSnapshotRunnerOutput(snapshot, facts) as Record<string, unknown>;
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(() => referenceCodeSnapshotFromRunnerOutput(encode({ ...output, digest: `sha256:${"0".repeat(64)}` }))).toThrow("reference_code_snapshot_output_invalid");
    expect(() => referenceCodeSnapshotFromRunnerOutput(encode({ ...output, files: "x" }))).toThrow("reference_code_snapshot_output_invalid");
    expect(() => referenceCodeSnapshotFromRunnerOutput(Uint8Array.of(0xff))).toThrow("reference_code_snapshot_output_invalid");
  });
});

describe("generateCandidate in the guest: one bounded model call (W4H-28 P1)", () => {
  const files = referenceCodeLaunchRepository();
  const treeSha = factoryGitTreeId(files.map(file => ({ path: file.path, mode: file.mode, content: file.content })));
  const connection = referenceCodeRecordedTree({ commitSha: COMMIT, treeSha, files, policy: REFERENCE_CODE_FIXTURE_POLICY, committedAtSeconds: REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS });
  const answer = JSON.stringify({ files: [{ path: "src/slugify.ts", content: REFERENCE_CODE_ACCEPTED_SLUGIFY }], summary: "Implemented slugify." });
  const pin = referenceCodeV1.graph.nodes.flatMap(node => (node.kind === "task" && node.runner.export === "generateCandidate" ? [node.runner] : []))[0]!;
  const model = { provider: "openai", model: pin.model!, configuration: {}, configurationDigest: pin.configurationDigest!, policy: {}, policyDigest: pin.configurationDigest! };

  /** Snapshots the fixture through the snapshot tool, then generates against that sealed snapshot. */
  async function generate(text: string, remediation = "") {
    const host = factoryGuestMaterialHost({ model: () => ({ text, usage: { kind: "measured", inputTokens: 900, outputTokens: 120, computeMs: 5, costMicros: "33" } }) });
    const snapshotRequest = { authority: { runId: "run", nodeInstanceId: "snapshot-repository", candidateGeneration: 0, nextOperationIndex: 0 }, input: { kind: "inline", value: { repositoryConnection: connection, baseCommitSha: COMMIT } } } as unknown as FactoryRunnerRequest;
    await REFERENCE_CODE_RUNNER_TOOLS.snapshotRepository(snapshotRequest, host.call);
    const port = (factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { snapshot: unknown }).snapshot;
    const request = { authority: { runId: "run", nodeInstanceId: "generate-private-candidate", candidateGeneration: 0, nextOperationIndex: 0 }, model, input: { kind: "inline", value: { snapshot: port, request: REFERENCE_CODE_FIXTURE_REQUEST.issue, baseBranch: "main", remediation } } } as unknown as FactoryRunnerRequest;
    const result = await REFERENCE_CODE_RUNNER_TOOLS.generateCandidate(request, host.call);
    return { host, result };
  }

  test("reads the sealed snapshot, makes exactly one call, and seals the complete resulting tree", async () => {
    const { host, result } = await generate(answer);
    expect(result).toMatchObject({ status: "completed", journalCursor: 0, usage: { inputTokens: 900, outputTokens: 120 } });
    expect(result.operations).toHaveLength(1);
    expect(host.models).toHaveLength(1);
    const [call] = host.models;
    expect(call?.maxOutputTokens).toBe(REFERENCE_CODE_GUEST_MAX_OUTPUT_TOKENS);
    expect(call?.model).toEqual(model);
    expect(call?.messages[0]?.text).toContain("These files are protected and must stay byte-identical: test/slugify.protected.test.ts");
    expect(call?.messages[1]?.text).toContain(REFERENCE_CODE_FIXTURE_REQUEST.issue);
    expect(call?.messages[1]?.text).toContain("=== src/slugify.ts ===");
    expect(call?.messages[1]?.text).not.toContain("A previous candidate was rejected");
    const generation = factoryGuestStagedJson(host.stored, REFERENCE_CODE_GENERATION_OUTPUT) as { files: { path: string; mode: "100644" | "100755"; contentBase64: string }[]; changedPaths: string[]; summary: string; baseSha: string };
    expect(referenceCodeFilesFromWire(generation.files)).toEqual([...referenceCodeFixtureCandidate("accepted")]);
    expect(generation).toMatchObject({ changedPaths: ["src/slugify.ts"], summary: "Implemented slugify.", baseSha: COMMIT });
    const port = factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { candidate: { digest: string } };
    expect(port.candidate.digest).toBe(`sha256:${sha256Hex(host.stored.get(REFERENCE_CODE_GENERATION_OUTPUT)!)}`);
    const node = referenceCodeV1.graph.nodes.find(candidate => candidate.id === "generate-private-candidate")!;
    expect(validateNodeOutput(node, port as never)).toBe(true);
  });

  test("a repair names the findings it must fix, and a fenced answer is accepted", async () => {
    const { host, result } = await generate(`\`\`\`json\n${answer}\n\`\`\``, "declared-tests: slugify throws");
    expect(result).toMatchObject({ status: "completed" });
    expect(host.models[0]?.messages[1]?.text).toContain("A previous candidate was rejected. Fix exactly these findings:\ndeclared-tests: slugify throws");
  });

  test("an answer the rules refuse fails the attempt by name, its one call still accounted", async () => {
    for (const text of ["not json", "[]", JSON.stringify({ files: [] }), JSON.stringify({ files: [{ path: "../escape.ts", content: "x" }] }), JSON.stringify({ files: [{ path: "src/a.ts", content: 7 }] })]) {
      const { result } = await generate(text);
      expect(result).toMatchObject({ status: "failed", journalCursor: 0, error: { code: "reference_code_answer_invalid", retryable: false }, usage: { outputTokens: 120 } });
      expect(result.operations).toHaveLength(1);
    }
  });

  test("an input that is not a request, a remediation and a snapshot port is refused before any call", async () => {
    const host = factoryGuestMaterialHost({ model: () => ({ text: answer }) });
    const bad = (value: unknown) => ({ authority: { runId: "run", nodeInstanceId: "g", candidateGeneration: 0, nextOperationIndex: 0 }, input: { kind: "inline", value } }) as unknown as FactoryRunnerRequest;
    await expect(REFERENCE_CODE_RUNNER_TOOLS.generateCandidate(bad({ snapshot: {}, request: 1, remediation: "" }), host.call)).rejects.toThrow("reference_code_runner_input_invalid");
    await expect(REFERENCE_CODE_RUNNER_TOOLS.generateCandidate(bad({ snapshot: { digest: "x" }, request: "r", remediation: "" }), host.call)).rejects.toMatchObject({ code: "guest_frame_invalid" });
    expect(host.models).toHaveLength(0);
  });
});

describe("freezeGitTree in the guest: the generated tree, frozen against the sealed snapshot (W4H-28)", () => {
  const files = referenceCodeLaunchRepository();
  const treeSha = factoryGitTreeId(files.map(file => ({ path: file.path, mode: file.mode, content: file.content })));
  const facts = { policy: REFERENCE_CODE_FIXTURE_POLICY, committedAtSeconds: REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS };
  const connection = referenceCodeRecordedTree({ commitSha: COMMIT, treeSha, files, ...facts });
  const answer = JSON.stringify({ files: [{ path: "src/slugify.ts", content: REFERENCE_CODE_ACCEPTED_SLUGIFY }], summary: "Implemented slugify." });
  const request = (node: string, value: unknown, generation = 0) => ({ authority: { runId: "run", nodeInstanceId: node, candidateGeneration: generation, nextOperationIndex: 0 }, model: { provider: "p", model: "m", configuration: {}, configurationDigest: "x", policy: {}, policyDigest: "x" }, input: { kind: "inline", value } }) as unknown as FactoryRunnerRequest;

  /** Snapshot, then generate, then freeze, through one in-memory host. */
  async function chain(text = answer) {
    const host = factoryGuestMaterialHost({ model: () => ({ text }) });
    await REFERENCE_CODE_RUNNER_TOOLS.snapshotRepository(request("snapshot-repository", { repositoryConnection: connection, baseCommitSha: COMMIT }), host.call);
    const snapshotPort = (factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { snapshot: unknown }).snapshot;
    await REFERENCE_CODE_RUNNER_TOOLS.generateCandidate(request("generate-private-candidate", { snapshot: snapshotPort, request: REFERENCE_CODE_FIXTURE_REQUEST.issue, baseBranch: "main", remediation: "" }), host.call);
    const candidatePort = (factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { candidate: unknown }).candidate;
    return { host, snapshotPort, candidatePort };
  }

  test("freezes the exact commit a release creates, its policy and time from the snapshot alone", async () => {
    const { host, snapshotPort, candidatePort } = await chain();
    const result = await REFERENCE_CODE_RUNNER_TOOLS.freezeGitTree(request("freeze-complete-git-tree", { candidate: candidatePort, snapshot: snapshotPort, baseCommitSha: COMMIT, request: REFERENCE_CODE_FIXTURE_REQUEST.issue, baseBranch: "main", release: "github" }, 1), host.call);
    expect(result).toMatchObject({ status: "completed", operations: [] });
    const snapshot = sealReferenceCodeSnapshot({ baseSha: COMMIT, treeSha, entries: files.map(file => ({ path: file.path, mode: file.mode, content: file.content })) });
    const expected = freezeReferenceCodeCandidate({
      snapshot, files: referenceCodeFixtureCandidate("accepted"), repositoryId: REFERENCE_CODE_FIXTURE_POLICY.repositoryId, baseBranch: "main", issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
      title: referenceCodePullRequestTitle(REFERENCE_CODE_FIXTURE_REQUEST.issue), allowedPaths: REFERENCE_CODE_FIXTURE_POLICY.allowedPaths, protectedPaths: REFERENCE_CODE_FIXTURE_POLICY.protectedPaths,
      authoredAtSeconds: REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS, candidateGeneration: 1,
    });
    expect(factoryGuestStagedJson(host.stored, REFERENCE_CODE_CANDIDATE_OUTPUT)).toEqual(JSON.parse(JSON.stringify(referenceCodeCandidateRunnerOutput(expected, snapshotPort as never, REFERENCE_CODE_FIXTURE_REQUEST.issue))));
    expect(expected.changedPaths).toEqual(["src/slugify.ts"]);
    expect(expected.publication.baseSha).toBe(COMMIT);
    const port = factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { candidate: unknown; frozen: { storage: string } };
    const node = referenceCodeV1.graph.nodes.find(candidate => candidate.id === "freeze-complete-git-tree")!;
    expect(validateNodeOutput(node, port as never)).toBe(true);
    // A GitHub release resolves from W07's own publication request, exactly as frozen.
    expect(port.candidate).toEqual(JSON.parse(JSON.stringify(expected.publication)));
    expect(assertFactoryGitHubPublicationRequest(port.candidate).request.commitSha).toBe(expected.commitSha);
  });

  test("an S3 release resolves from the accepted publication of the frozen record, sealed by the freeze itself", async () => {
    const { host, snapshotPort, candidatePort } = await chain();
    const frozen = request("freeze-complete-git-tree", { candidate: candidatePort, snapshot: snapshotPort, baseCommitSha: COMMIT, request: REFERENCE_CODE_FIXTURE_REQUEST.issue, baseBranch: "main", release: "s3" });
    await REFERENCE_CODE_RUNNER_TOOLS.freezeGitTree(frozen, host.call);
    const port = factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { candidate: unknown };
    expect(assertFactoryS3AcceptedPublication(port.candidate)).toEqual(referenceCodeS3Publication(frozen));
    // The record names the operation this freeze staged its candidate.json under.
    const staged = host.frames.find(frame => frame.objectName === REFERENCE_CODE_CANDIDATE_OUTPUT && frame.schemaVersion === "factory.guest-material-seal.v1")!;
    expect(staged.operationId).toBe(referenceCodeS3Publication(frozen).materialOperationId);
  });

  test("a snapshot of another base, or a generation that is not this snapshot's, is refused by name", async () => {
    const { host, snapshotPort, candidatePort } = await chain();
    const freeze = (value: Record<string, unknown>) => REFERENCE_CODE_RUNNER_TOOLS.freezeGitTree(request("freeze-complete-git-tree", { candidate: candidatePort, snapshot: snapshotPort, baseCommitSha: COMMIT, request: "r", baseBranch: "main", release: "s3", ...value }), host.call);
    await expect(freeze({ baseCommitSha: "2".repeat(40) })).rejects.toThrow("reference_code_runner_input_invalid");
    await expect(freeze({ baseBranch: 3 })).rejects.toThrow("reference_code_runner_input_invalid");
    await expect(freeze({ release: "ftp" })).rejects.toThrow("reference_code_runner_input_invalid");
    // The snapshot handed in where the generation belongs: valid bytes, wrong kind.
    await expect(freeze({ candidate: snapshotPort })).rejects.toThrow("the candidate is not a generation of this snapshot's base");
    const generation = JSON.parse(new TextDecoder().decode(host.stored.get(REFERENCE_CODE_GENERATION_OUTPUT)!)) as Record<string, unknown>;
    const stage = async (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const artifactId = `object-forged-${host.byId.size}`;
      host.byId.set(artifactId, bytes);
      return { digest: `sha256:${sha256Hex(bytes)}`, mediaType: "application/json", storage: artifactId };
    };
    await expect(freeze({ candidate: await stage({ ...generation, filesDigest: `sha256:${"0".repeat(64)}` }) })).rejects.toThrow("the generation's files are not the digest it records");
    const notJson = Uint8Array.of(0xff);
    host.byId.set("object-not-json", notJson);
    await expect(freeze({ candidate: { digest: `sha256:${sha256Hex(notJson)}`, mediaType: "application/json", storage: "object-not-json" } })).rejects.toThrow("the generation is not UTF-8 JSON");
  });

  test("a title is the request's first sentence, bounded", () => {
    expect(referenceCodePullRequestTitle(REFERENCE_CODE_FIXTURE_REQUEST.issue).length).toBeLessThanOrEqual(72);
    expect(referenceCodePullRequestTitle("Add a greeting. Then more.")).toBe("Add a greeting.");
    expect(referenceCodePullRequestTitle("   ")).toBe("Reference code candidate");
  });
});
