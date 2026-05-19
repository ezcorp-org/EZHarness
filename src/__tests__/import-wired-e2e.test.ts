// FULLY-WIRED smoke: NO stubbed boundaries. Real PGlite + real
// migrations + real createUserCommand + real synthesizeSkillExtension
// + real installFromLocal + real getExtensionByName, then the
// *installed* runner is spawned for real and asked to run a bundled
// script. This closes the gap the other suites leave (they stub the
// DB / installer / registry); it proves the genuine commit path.

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
} from "bun:test";
import { mkdir, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
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
const { installFromLocal } = await import("../extensions/installer");
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

let projectRoot: string;
let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "wired@test.local",
    passwordHash: "x",
    name: "Wired",
  });
  userId = u.id;
  await createProject({ name: "Wired", path: "/tmp/wired" });
  // Under the repo so the synthesized config's `@ezcorp/sdk` import
  // resolves the same way a real <projectRoot>/.ezcorp install does.
  // `.ezcorp/` is gitignored — no repo residue.
  projectRoot = join(
    process.cwd(),
    ".ezcorp",
    "wired-test",
    crypto.randomUUID(),
  );
  await mkdir(projectRoot, { recursive: true });
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await closeTestDb();
});

function file(content: string, name: string): File {
  return new File([content], name);
}

describe("import wizard — fully wired (real DB + real installer)", () => {
  test("upload → scan → real createUserCommand + real installFromLocal → installed runner executes", async () => {
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
    const inst = await installFromLocal(
      destDir,
      { grantedAt: {} } as never,
      false, // installed DISABLED — matches the wizard
      { isBundled: false, userId },
    );
    expect(inst.id).toBeTruthy();
    expect(inst.enabled).toBe(false);

    const extRow = await getExtensionByName(bundle.name);
    expect(extRow?.id).toBe(inst.id);
    expect(existsSync(join(destDir, "ezcorp.config.ts"))).toBe(true);
    expect(existsSync(join(destDir, "index.ts"))).toBe(true);
    expect(existsSync(join(destDir, "skill/say.sh"))).toBe(true);

    // 4) Runnable proof: spawn the INSTALLED runner and invoke
    //    run_script — the exact subprocess the host would spawn.
    await chmod(join(destDir, "skill/say.sh"), 0o755);
    const proc = Bun.spawn(["bun", join(destDir, "index.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_script", arguments: { script: "say.sh", args: ["X"] } },
      }) + "\n",
    );
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const resp = JSON.parse(out.trim().split("\n").filter(Boolean)[0]!);
    expect(resp.result.isError).toBe(false);
    expect(resp.result.content[0].text).toContain("SMOKE_OK_X");
    expect(resp.result.content[0].text).toContain("exit 0");
  });
});
