import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceCodeV1, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk";
import { validateFactoryValidatorClaimReport } from "@ezcorp/factory-sdk/validation";
import { validateNodeOutput } from "@ezcorp/factory-sdk/kernel";
import { factoryGuestStagedJson } from "../../__tests__/helpers/factory-guest-material-host";
import { referenceCodeGuestChain, referenceCodeGuestRequest } from "../../__tests__/helpers/reference-code-guest-chain";
import { REFERENCE_CODE_LAUNCH_FILES } from "./fixtures";
import { REFERENCE_CODE_CHECKS_OUTPUT, REFERENCE_CODE_RESULT_OUTPUT, REFERENCE_CODE_RUNNER_TOOLS, referenceCodeCheckSubject, referenceCodeProtectedChecksTool } from "./runner-entry";
import { REFERENCE_CODE_RUNNER_PACKAGES, referenceCodeRunnerPackageFiles } from "./runner-packages";
import TOOLCHAIN_LOCK from "./toolchain.lock.json" with { type: "json" };
import { linkReferenceCodeToolchain } from "./workspace";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory(prefix: string): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), prefix));
  directories.push(made);
  return made;
}

describe("the toolchain claims lane (W4H-28 P3)", () => {
  test("links every package of a read-only toolchain, scoped ones included, and each declared binary", async () => {
    const toolchain = await directory("toolchain-");
    const modules = join(toolchain, "node_modules");
    await mkdir(join(modules, "typescript", "bin"), { recursive: true });
    await writeFile(join(modules, "typescript", "package.json"), JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } }));
    await mkdir(join(modules, "@types", "bun"), { recursive: true });
    await writeFile(join(modules, "@types", "bun", "package.json"), JSON.stringify({ name: "@types/bun" }));
    await mkdir(join(modules, "single"), { recursive: true });
    await writeFile(join(modules, "single", "package.json"), JSON.stringify({ name: "single", bin: "cli.js" }));
    await mkdir(join(modules, ".cache"), { recursive: true });
    await writeFile(join(modules, ".package-lock.json"), "{}");
    await mkdir(join(modules, "@types", "loose-file-dir"), { recursive: true });
    await writeFile(join(modules, "@types", "README"), "x");
    await writeFile(join(modules, "@types", "loose-file-dir", "package.json"), JSON.stringify({ name: "@types/loose-file-dir" }));

    const root = await directory("workspace-");
    await linkReferenceCodeToolchain(root, toolchain);
    expect(await readlink(join(root, "node_modules", "typescript"))).toBe(join(modules, "typescript"));
    expect(await readlink(join(root, "node_modules", "@types", "bun"))).toBe(join(modules, "@types", "bun"));
    expect(await readlink(join(root, "node_modules", ".bin", "tsc"))).toBe(join(modules, "typescript", "bin", "tsc"));
    expect(await readlink(join(root, "node_modules", ".bin", "single"))).toBe(join(modules, "single", "cli.js"));
    await expect(lstat(join(root, "node_modules", ".cache"))).rejects.toThrow();
  });

  test("the validator package locks exactly the fixture's toolchain, by version and SHA-512", async () => {
    // bun.lock is JSON with trailing commas; its packages map name -> [name@version, registry, metadata, integrity].
    const lock = JSON.parse(REFERENCE_CODE_LAUNCH_FILES["bun.lock"]!.replace(/,(\s*[}\]])/g, "$1")) as { packages: Record<string, [string, string, { dependencies?: Record<string, string> }, string]> };
    const locked = TOOLCHAIN_LOCK.packages as Record<string, { version?: string; integrity?: string; dependencies?: Record<string, string> }>;
    for (const [name, [identity, , metadata, integrity]] of Object.entries(lock.packages)) {
      const entry = locked[`node_modules/${name}`]!;
      expect(`${name}@${entry.version}`).toBe(identity);
      expect(entry.integrity).toBe(integrity);
      expect(entry.dependencies ?? {}).toEqual(metadata.dependencies ?? {});
    }
    expect(Object.keys(locked).filter(key => key !== "").length).toBe(Object.keys(lock.packages).length);
    const validator = REFERENCE_CODE_RUNNER_PACKAGES.find(entry => entry.exports.includes("protectedChecks" as never))!;
    const files = await referenceCodeRunnerPackageFiles(validator.manifestName);
    expect(JSON.parse(files["package.json"] as string).devDependencies).toEqual(TOOLCHAIN_LOCK.packages[""].dependencies);
    expect(JSON.parse(files["package-lock.json"] as string)).toEqual(TOOLCHAIN_LOCK);
    const generator = await referenceCodeRunnerPackageFiles(REFERENCE_CODE_RUNNER_PACKAGES.find(entry => entry !== validator)!.manifestName);
    expect(generator).not.toHaveProperty(["package.json"]);
  });
});

describe("protectedChecks and supervisedReview in the guest (W4H-28 P3)", () => {
  test("a validator is handed the frozen node's output by reference and reads the whole subject from it", async () => {
    const chain = await referenceCodeGuestChain();
    const subject = await referenceCodeCheckSubject(referenceCodeGuestRequest("acceptance:validator", { kind: "artifact", artifact: chain.frozenOutput }), chain.host.call);
    expect(subject.candidate.changedPaths).toEqual(["src/slugify.ts"]);
    expect(subject.sealed.policy.protectedTestPaths).toEqual(["test/slugify.protected.test.ts"]);
    expect(subject.issue.length).toBeGreaterThan(0);
    const inline = await referenceCodeCheckSubject(referenceCodeGuestRequest("protected-checks", { kind: "inline", value: { candidate: chain.candidate } } as FactoryRunnerRequest["input"]), chain.host.call);
    expect(inline.candidate.commitSha).toBe(subject.candidate.commitSha);
  });

  test("a subject that is not a frozen candidate of its snapshot is refused by name", async () => {
    const chain = await referenceCodeGuestChain();
    const subject = (port: unknown) => referenceCodeCheckSubject(referenceCodeGuestRequest("protected-checks", { kind: "inline", value: { candidate: port } } as FactoryRunnerRequest["input"]), chain.host.call);
    // The generation handed in where the frozen candidate belongs.
    await expect(subject(chain.generated)).rejects.toThrow("the candidate is not a frozen reference-code candidate");
    const frozen = JSON.parse(new TextDecoder().decode(chain.host.stored.get("candidate.json")!)) as Record<string, unknown>;
    const stage = (value: unknown) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new TextEncoder().encode(JSON.stringify(value));
      const artifactId = `object-forged-${chain.host.byId.size}`;
      chain.host.byId.set(artifactId, bytes);
      return { digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`, mediaType: "application/json", storage: artifactId };
    };
    await expect(subject(stage({ ...frozen, filesDigest: `sha256:${"0".repeat(64)}` }))).rejects.toThrow("the frozen tree is not the digest it records");
    await expect(subject(stage("[]"))).rejects.toThrow("the frozen candidate is not a JSON object");
    await expect(subject(stage("\u0000{"))).rejects.toThrow("the frozen candidate is not UTF-8 JSON");
  });

  test("as a validator it answers the nine-claim report; with no toolchain the frozen install fails by name, never a pass", async () => {
    const chain = await referenceCodeGuestChain();
    const toolchain = await directory("empty-toolchain-");
    await mkdir(join(toolchain, "node_modules"));
    const result = await referenceCodeProtectedChecksTool(toolchain)(referenceCodeGuestRequest("acceptance:validator", { kind: "artifact", artifact: chain.frozenOutput }, { model: false }), chain.host.call);
    expect(result).toMatchObject({ status: "completed", operations: [] });
    const report = factoryGuestStagedJson(chain.host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { claims: { id: string; verdict: string }[] };
    expect(validateFactoryValidatorClaimReport(report)).toEqual({ ok: true });
    const verdicts = Object.fromEntries(report.claims.map(claim => [claim.id, claim.verdict]));
    expect(Object.keys(verdicts).sort()).toEqual(referenceCodeV1.acceptance.claims.filter(claim => claim.validator.export === "protectedChecks").map(claim => claim.id).sort());
    expect(verdicts["frozen-install"]).toBe("FAIL");
    expect(verdicts.build).toBe("INCONCLUSIVE");
    expect(verdicts["allowed-paths"]).toBe("PASS");
  }, 120_000);

  test("as the protected-checks task it seals the report and the command record as one evidence material", async () => {
    const chain = await referenceCodeGuestChain();
    const toolchain = await directory("empty-toolchain-");
    await mkdir(join(toolchain, "node_modules"));
    await referenceCodeProtectedChecksTool(toolchain)(referenceCodeGuestRequest("protected-checks", { kind: "inline", value: { candidate: chain.candidate } } as FactoryRunnerRequest["input"], { model: false }), chain.host.call);
    const port = factoryGuestStagedJson(chain.host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { evidence: unknown[] };
    const node = referenceCodeV1.graph.nodes.find(candidate => candidate.id === "protected-checks")!;
    expect(validateNodeOutput(node, port as never)).toBe(true);
    const evidence = factoryGuestStagedJson(chain.host.stored, REFERENCE_CODE_CHECKS_OUTPUT) as { report: { claims: unknown[] }; commands: { command: string[]; output: string }[] };
    expect(evidence.report.claims).toHaveLength(9);
    expect(evidence.commands[0]?.command).toEqual(["bun", "install", "--frozen-lockfile", "--no-progress", "--offline"]);
  }, 120_000);

  test("supervisedReview makes one call and reports the rubric's verdict as its one claim", async () => {
    const answer = JSON.stringify({ matchesRequest: true, noUnrequestedEffect: true, noKnownCriticalIssue: true, reason: "It implements slugify." });
    const chain = await referenceCodeGuestChain({ review: () => ({ text: answer }) });
    const result = await REFERENCE_CODE_RUNNER_TOOLS.supervisedReview(referenceCodeGuestRequest("acceptance:review", { kind: "artifact", artifact: chain.frozenOutput }), chain.host.call);
    expect(result).toMatchObject({ status: "completed", journalCursor: 0 });
    expect(chain.host.models).toHaveLength(2);
    expect(chain.host.models[1]?.messages[1]?.text).toContain("src/slugify.ts");
    const report = factoryGuestStagedJson(chain.host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { claims: { id: string; verdict: string }[] };
    expect(validateFactoryValidatorClaimReport(report)).toEqual({ ok: true });
    expect(report.claims).toEqual([expect.objectContaining({ id: "supervised-review", verdict: "PASS" })]);
    const broken = await referenceCodeGuestChain({ review: () => ({ text: "looks fine" }) });
    await REFERENCE_CODE_RUNNER_TOOLS.supervisedReview(referenceCodeGuestRequest("acceptance:review", { kind: "artifact", artifact: broken.frozenOutput }), broken.host.call);
    expect((factoryGuestStagedJson(broken.host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { claims: { verdict: string }[] }).claims[0]?.verdict).toBe("VALIDATOR_ERROR");
  });
});

// The default tool reads its toolchain from the guest's package root.
test("the registered protectedChecks tool is the lane over the working directory", async () => {
  expect(typeof REFERENCE_CODE_RUNNER_TOOLS.protectedChecks).toBe("function");
  expect(await readFile(join(import.meta.dir, "toolchain.lock.json"), "utf8")).toContain('"lockfileVersion": 3');
  void (null as unknown as JsonValue);
});
