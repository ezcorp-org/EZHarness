import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
} from "bun:test";
import { mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FramedExecution } from "@ezcorp/extension-runner";
import { snapshotExtensionSource } from "../../scripts/migrate-extension-v4";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getDb } from "../db/connection";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { useTempProjectRoot, type TempProjectRoot } from "./helpers/temp-project-root";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createUserCommand, getUserCommand } = await import(
  "../db/queries/user-commands"
);
const { getExtensionByName } = await import("../db/queries/extensions");
const { stageExtensionSourceFiles } = await import("../extensions/source-import");
const {
  stageDirectoryUpload,
  resolveScanRoot,
} = await import("../runtime/import/staging");
const { discoverProjectCommands } = await import(
  "../runtime/commands/discovery"
);
const { scanSkillBundles, synthesizeSkillExtension } = await import(
  "../runtime/import/skill-bundle"
);

afterAll(() => restoreModuleMocks());

let tmpRoot: TempProjectRoot;
let projectRoot: string;
let userId: string;
const previousBlobRoot = process.env.EZCORP_EXTENSION_BLOB_ROOT;
const previousSocket = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
const previousToken = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "wired@test.local",
    passwordHash: "x",
    name: "Wired",
    role: "admin",
  });
  userId = u.id;
  // A throwaway root that LOOKS like the repo (it links `node_modules` /
  // `packages` in), so the synthesized config's `@ezcorp/sdk` import
  // resolves the same way a real `<projectRoot>/.ezcorp` install does.
  // Previously this was `<repo>/.ezcorp/wired-test/<uuid>` — inside the
  // checkout, and it left the empty parent dir behind every run.
  tmpRoot = useTempProjectRoot("import-wired-");
  projectRoot = join(tmpRoot.root, ".ezcorp", "wired-test", crypto.randomUUID());
  await mkdir(projectRoot, { recursive: true });
  await createProject({ name: "Wired", path: projectRoot });
  process.env.EZCORP_EXTENSION_BLOB_ROOT = join(tmpRoot.root, "blobs");
  process.env.EZCORP_EXTENSION_RUNNER_SOCKET = join(tmpRoot.root, "unavailable-runner.sock");
  process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "test-runner-token-with-at-least-32-bytes";
});

afterAll(async () => {
  await closeTestDb();
  tmpRoot.cleanup();
  if (previousBlobRoot === undefined) delete process.env.EZCORP_EXTENSION_BLOB_ROOT;
  else process.env.EZCORP_EXTENSION_BLOB_ROOT = previousBlobRoot;
  if (previousSocket === undefined) delete process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  else process.env.EZCORP_EXTENSION_RUNNER_SOCKET = previousSocket;
  if (previousToken === undefined) delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  else process.env.EZCORP_EXTENSION_RUNNER_TOKEN = previousToken;
});

function file(content: string, name: string): File {
  return new File([content], name);
}

describe("import wizard — real DB, immutable workspace and v4 source protocol", () => {
  test("upload and scan preserve commands, stage an unapproved build, and produce callable v4 source", async () => {
    // 1) Real staged upload of a command + a runnable skill bundle.
    const staged = await stageDirectoryUpload({
      projectRoot,
      files: [
        file("---\ndescription: Greet someone\n---\nHello $1", "greet.md"),
        file(
          "---\nname: Echoer\ndescription: Echoes a marker\n---\nRun say.sh",
          "SKILL.md",
        ),
        file("#!/bin/bash\necho SMOKE_OK_$1\n", "say.sh"),
      ],
      paths: [
        ".claude/commands/greet.md",
        ".claude/skills/echoer/SKILL.md",
        ".claude/skills/echoer/say.sh",
      ],
    });

    const scanRoot = await resolveScanRoot(staged.dir);
    const cmds = await discoverProjectCommands(scanRoot);
    const skills = await scanSkillBundles(scanRoot);
    expect(cmds.map((c) => c.name)).toEqual(["greet"]);
    expect(skills.map((s) => s.name)).toEqual(["echoer"]);

    // 2) Real command write → read back from real PGlite.
    const cmd = cmds[0]!;
    const created = await createUserCommand({
      userId,
      name: cmd.name,
      description: cmd.description,
      body: cmd.body,
      frontmatter: { ...cmd.frontmatter, imported: cmd.source },
    });
    const fromDb = await getUserCommand(userId, created.name);
    expect(fromDb?.body).toContain("Hello $1");
    expect(fromDb?.frontmatter.imported).toBe("project:claude-commands");

    // 3) Real synthesize → real installFromLocal → real extensions row.
    const bundle = skills[0]!;
    expect(await getExtensionByName(bundle.name)).toBeNull();
    const destDir = join(projectRoot, ".ezcorp/extensions", bundle.name);
    await synthesizeSkillExtension({
      bundle,
      destDir,
      name: bundle.name,
    });
    const snapshot = await snapshotExtensionSource(projectRoot, { name: bundle.name, directory: `.ezcorp/extensions/${bundle.name}`, entrypoint: "extension.ts" });
    const stagedSource = await stageExtensionSourceFiles({ principalId: userId, scope: "global", kind: "human" }, snapshot.files, { kind: "skill", name: bundle.name });
    const inst = stagedSource.installation;
    expect(inst.id).toBeTruthy();
    expect(inst.enabled).toBe(false);

    const state = await new DatabaseLifecycleRepository(getDb()).read(inst.id);
    expect(state?.installation.activeReleaseId).toBeNull();
    expect(state?.installation.ownerId).toBe(userId);
    expect(state?.approvals).toEqual({});
    expect(state?.workspaces[stagedSource.workspace.id]?.sourceDigest).toBe(stagedSource.workspace.sourceDigest);
    expect(state?.operations[stagedSource.operation.id]).toBeDefined();
    expect(existsSync(join(destDir, "ezcorp.config.ts"))).toBe(true);
    expect(existsSync(join(destDir, "index.ts"))).toBe(true);
    expect(existsSync(join(destDir, "skill/say.sh"))).toBe(true);

    // 4) Runnable proof: spawn the INSTALLED runner and invoke
    //    run_script — the exact subprocess the host would spawn.
    await chmod(join(destDir, "skill/say.sh"), 0o755);
    const proc = spawn(process.execPath, [join(destDir, "extension.ts")], { cwd: destDir, stdio: "pipe" });
    const execution = new FramedExecution("skill-wired", proc, async () => { throw new Error("No host effects permitted in source verification"); }, async () => { proc.kill(); }, 1024 * 1024, 10_000);
    try {
      const manifest = await execution.request("extension/discover", {}) as { schemaVersion: number };
      expect(manifest.schemaVersion).toBe(4);
      const response = await execution.request("extension/invoke", {
        name: "run_script", input: { script: "say.sh", args: ["X"] },
        context: { invocationId: "wired", workerId: "worker", releaseId: "release", principalId: userId, scopeId: "global", token: "test", deadline: Date.now() + 10_000 },
      }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(response.isError).toBe(false);
      expect(response.content[0]!.text).toContain("SMOKE_OK_X");
      expect(response.content[0]!.text).toContain("exit 0");
    } finally { await execution.close(); }
  });
});
