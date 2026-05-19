import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectCommands,
  discoverHomeCommands,
  SKILL_BUNDLE_FILENAME,
} from "../runtime/commands/discovery";

// A `SKILL.md` is the root marker of a Claude skill bundle. The
// skill-bundle importer owns these; the command walk must never
// surface one as a loose command (otherwise an imported skill would
// double-import as a junk command named "SKILL").
describe("discovery excludes SKILL.md from the command walk", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skillmd-excl-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the marker constant is exactly SKILL.md", () => {
    expect(SKILL_BUNDLE_FILENAME).toBe("SKILL.md");
  });

  test("a SKILL.md sitting in .claude/commands is not returned as a command", async () => {
    const dir = join(root, ".claude/commands");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, SKILL_BUNDLE_FILENAME),
      "---\ndescription: a skill\n---\nskill body",
      "utf8",
    );
    await writeFile(
      join(dir, "review.md"),
      "---\ndescription: real cmd\n---\nbody",
      "utf8",
    );

    const cmds = await discoverProjectCommands(root);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.name).toBe("review");
    expect(cmds.some((c) => c.name === "SKILL")).toBe(false);
  });

  test("SKILL.md nested in a command subdirectory is also skipped", async () => {
    const dir = join(root, ".codex/prompts/nested");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, SKILL_BUNDLE_FILENAME),
      "---\ndescription: nested skill\n---\nbody",
      "utf8",
    );

    const cmds = await discoverProjectCommands(root);
    expect(cmds).toEqual([]);
  });

  test("home-dir command roots skip SKILL.md too", async () => {
    const dir = join(root, ".claude/agents");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, SKILL_BUNDLE_FILENAME),
      "---\ndescription: home skill\n---\nbody",
      "utf8",
    );
    await writeFile(
      join(dir, "agent.md"),
      "---\ndescription: real agent\n---\nbody",
      "utf8",
    );

    const cmds = await discoverHomeCommands(root);
    expect(cmds.map((c) => c.name)).toEqual(["agent"]);
  });
});
