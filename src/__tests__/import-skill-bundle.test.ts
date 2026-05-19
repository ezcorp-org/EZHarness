import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  skillExtensionName,
  scanSkillBundles,
  synthesizeSkillExtension,
  buildSkillManifestSource,
  SKILL_TOOLS,
  DEFAULT_SCAN_LIMITS,
} from "../runtime/import/skill-bundle";
import {
  handleRequest,
  commandFor,
} from "../runtime/import/skill-runner.template";
import { loadManifest } from "../extensions/loader";
import { validateManifestV2 } from "../extensions/manifest";

async function bundle(
  root: string,
  rel: string,
  frontmatter: string,
  body: string,
): Promise<string> {
  const dir = join(root, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n${body}`,
    "utf8",
  );
  return dir;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "imp-skill-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("skillExtensionName", () => {
  test("slugs a human label", () => {
    expect(skillExtensionName("My Cool Skill!")).toBe("my-cool-skill");
  });
  test("strips leading junk", () => {
    expect(skillExtensionName("  $$$Foo Bar")).toBe("foo-bar");
  });
  test("collapses dot runs (no '..')", () => {
    expect(skillExtensionName("a..b...c")).toBe("a.b.c");
  });
  test("trims trailing separators", () => {
    expect(skillExtensionName("trailing---")).toBe("trailing");
  });
  test("falls back when nothing survives", () => {
    expect(skillExtensionName("***")).toBe("skill");
  });
  test("output always satisfies the manifest name rule", () => {
    const n = skillExtensionName("X".repeat(200) + " !!! weird .. name");
    expect(n.length).toBeLessThanOrEqual(64);
    expect(/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(n)).toBe(true);
    expect(n.includes("..")).toBe(false);
  });
});

describe("scanSkillBundles", () => {
  test("returns [] for a missing root", async () => {
    expect(await scanSkillBundles(join(root, "nope"))).toEqual([]);
  });

  test("discovers a bundle with frontmatter + scripts", async () => {
    const dir = await bundle(
      root,
      ".claude/skills/foo",
      "name: Foo\ndescription: Does foo",
      "Foo instructions body",
    );
    await writeFile(join(dir, "run.sh"), "echo hi", "utf8");
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(join(dir, "lib/helper.py"), "print(1)", "utf8");

    const [b, ...rest] = await scanSkillBundles(root);
    expect(rest).toHaveLength(0);
    expect(b!.id).toBe("foo");
    expect(b!.name).toBe("foo");
    expect(b!.rawName).toBe("Foo");
    expect(b!.description).toBe("Does foo");
    expect(b!.instructions).toBe("Foo instructions body");
    expect(b!.dir).toBe(dir);
    expect(b!.scripts.sort()).toEqual(["lib/helper.py", "run.sh"]);
  });

  test("falls back to dir name + synthetic description", async () => {
    await bundle(root, "skills/bar", "unrelated: x", "body");
    const [b] = await scanSkillBundles(root);
    expect(b!.rawName).toBe("bar");
    expect(b!.description).toBe("Imported Claude skill: bar");
  });

  test("suffixes colliding ids (incl. multi-iteration)", async () => {
    await bundle(root, "a", "name: Same", "x");
    await bundle(root, "b", "name: Same", "y");
    await bundle(root, "c", "name: Same", "z");
    const ids = (await scanSkillBundles(root)).map((s) => s.id).sort();
    expect(ids).toEqual(["same", "same-2", "same-3"]);
  });

  test("skips an unreadable SKILL.md file", async () => {
    const dir = join(root, "locked");
    await mkdir(dir, { recursive: true });
    const md = join(dir, "SKILL.md");
    await writeFile(md, "name: X", "utf8");
    await chmod(md, 0o000);
    try {
      expect(await scanSkillBundles(root)).toEqual([]);
    } finally {
      await chmod(md, 0o644);
    }
  });

  test("skips an unreadable subdirectory", async () => {
    await bundle(root, "ok", "name: Ok", "x");
    const locked = join(root, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      const ids = (await scanSkillBundles(root)).map((s) => s.id);
      expect(ids).toEqual(["ok"]);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test("a bundle's unreadable script subdir is skipped, not fatal", async () => {
    const dir = await bundle(root, "sk", "name: Sk", "x");
    await writeFile(join(dir, "ok.sh"), "echo hi", "utf8");
    const lockedSub = join(dir, "private");
    await mkdir(lockedSub, { recursive: true });
    await writeFile(join(lockedSub, "secret.sh"), "x", "utf8");
    await chmod(lockedSub, 0o000);
    try {
      const [b] = await scanSkillBundles(root);
      expect(b!.scripts).toContain("ok.sh");
      expect(b!.scripts.some((s) => s.startsWith("private/"))).toBe(false);
    } finally {
      await chmod(lockedSub, 0o755);
    }
  });

  test("skips excluded dirs", async () => {
    await bundle(root, "node_modules/pkg", "name: Hidden", "x");
    await bundle(root, ".git/h", "name: AlsoHidden", "x");
    await bundle(root, "real", "name: Real", "x");
    const ids = (await scanSkillBundles(root)).map((s) => s.id);
    expect(ids).toEqual(["real"]);
  });

  test("treats a bundle as a leaf (no nested re-scan)", async () => {
    const dir = await bundle(root, "outer", "name: Outer", "x");
    await bundle(root, "outer/inner", "name: Inner", "y");
    const found = await scanSkillBundles(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.rawName).toBe("Outer");
    expect(found[0]!.scripts).toContain("inner/SKILL.md");
    void dir;
  });

  test("respects the bundle cap", async () => {
    await bundle(root, "x", "name: X", "a");
    await bundle(root, "y", "name: Y", "b");
    const found = await scanSkillBundles(root, {
      ...DEFAULT_SCAN_LIMITS,
      maxBundles: 1,
    });
    expect(found).toHaveLength(1);
  });

  test("respects the script cap", async () => {
    const dir = await bundle(root, "s", "name: S", "x");
    await writeFile(join(dir, "a"), "1", "utf8");
    await writeFile(join(dir, "b"), "2", "utf8");
    const [b] = await scanSkillBundles(root, {
      ...DEFAULT_SCAN_LIMITS,
      maxScripts: 1,
    });
    expect(b!.scripts).toHaveLength(1);
  });

  test("respects the depth cap", async () => {
    await bundle(root, "deep/inner", "name: Deep", "x");
    const found = await scanSkillBundles(root, {
      ...DEFAULT_SCAN_LIMITS,
      maxDepth: 0,
    });
    expect(found).toEqual([]);
  });

  test("skips a SKILL.md that fails to read", async () => {
    // A directory whose `SKILL.md` is itself a directory → read throws.
    const dir = join(root, "broken");
    await mkdir(join(dir, "SKILL.md"), { recursive: true });
    expect(await scanSkillBundles(root)).toEqual([]);
  });
});

describe("buildSkillManifestSource / synthesizeSkillExtension", () => {
  test("synthesized package loads + validates", async () => {
    const dir = await bundle(
      root,
      ".claude/skills/quote",
      'name: Quote\ndescription: He said "hi"',
      "instructions",
    );
    await writeFile(join(dir, "run.sh"), "#!/bin/bash\necho ok\n", "utf8");
    const [b] = await scanSkillBundles(root);

    // destDir must sit under the repo so the synthesized config's
    // `@ezcorp/sdk` import resolves the same way a real install
    // (under <projectRoot>/.ezcorp/extensions/) does. `.ezcorp/` is
    // gitignored, so this leaves no repo residue.
    const destDir = join(
      process.cwd(),
      ".ezcorp",
      "test-import",
      crypto.randomUUID(),
    );
    try {
      await synthesizeSkillExtension({ bundle: b!, destDir, name: "quote-2" });

      expect(await Bun.file(join(destDir, "ezcorp.config.ts")).exists()).toBe(true);
      expect(await Bun.file(join(destDir, "index.ts")).exists()).toBe(true);
      expect(await Bun.file(join(destDir, "skill/SKILL.md")).exists()).toBe(true);
      expect(await Bun.file(join(destDir, "skill/run.sh")).exists()).toBe(true);

      const manifest = await loadManifest(destDir);
      expect(manifest.name).toBe("quote-2");
      expect(manifest.tools?.length).toBe(3);
      const v = validateManifestV2({ ...manifest, schemaVersion: 2 });
      expect(v.valid).toBe(true);
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test("manifest source embeds JSON-escaped fields", () => {
    const src = buildSkillManifestSource("abc", 'a "quote"\nnewline');
    expect(src).toContain('name: "abc"');
    expect(src).toContain(JSON.stringify('a "quote"\nnewline'));
    expect(src).toContain("shell: true");
  });
});

describe("skill-runner: commandFor", () => {
  test.each([
    ["s.py", "python3"],
    ["s.js", "bun"],
    ["s.ts", "bun"],
    ["s.mjs", "bun"],
    ["s.rb", "ruby"],
    ["s.pl", "perl"],
    ["s.sh", "bash"],
    ["s.bash", "bash"],
  ])("%s → %s", (file, interp) => {
    expect(commandFor(file, ["a"])).toEqual([interp, file, "a"]);
  });
  test("unknown extension execs directly", () => {
    expect(commandFor("/abs/tool", [])).toEqual(["/abs/tool"]);
  });
});

describe("skill-runner: handleRequest", () => {
  let skillDir: string;
  const prevDir = process.env.EZCORP_SKILL_DIR;
  const prevTo = process.env.EZCORP_SKILL_RUN_TIMEOUT_MS;

  beforeEach(async () => {
    skillDir = await mkdtemp(join(tmpdir(), "imp-runner-"));
    process.env.EZCORP_SKILL_DIR = skillDir;
    await writeFile(join(skillDir, "SKILL.md"), "the instructions", "utf8");
  });
  afterEach(async () => {
    if (prevDir === undefined) delete process.env.EZCORP_SKILL_DIR;
    else process.env.EZCORP_SKILL_DIR = prevDir;
    if (prevTo === undefined) delete process.env.EZCORP_SKILL_RUN_TIMEOUT_MS;
    else process.env.EZCORP_SKILL_RUN_TIMEOUT_MS = prevTo;
    await rm(skillDir, { recursive: true, force: true });
  });

  function call(name: string, args: Record<string, unknown> = {}) {
    return handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  test("tools/list returns the three tools", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/list",
    });
    const tools = (res.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(SKILL_TOOLS.map((t) => t.name));
  });

  test("unknown method errors", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "weird",
    });
    expect(res.error?.code).toBe(-32601);
  });

  test("skill_info returns SKILL.md", async () => {
    const res = await call("skill_info");
    const c = res.result as { content: { text: string }[]; isError: boolean };
    expect(c.content[0]!.text).toBe("the instructions");
    expect(c.isError).toBe(false);
  });

  test("skill_info flags a missing SKILL.md", async () => {
    await rm(join(skillDir, "SKILL.md"));
    const res = await call("skill_info");
    expect((res.result as { isError: boolean }).isError).toBe(true);
  });

  test("list_scripts lists files, excluding SKILL.md", async () => {
    await writeFile(join(skillDir, "run.sh"), "echo hi", "utf8");
    const res = await call("list_scripts");
    expect((res.result as { content: { text: string }[] }).content[0]!.text).toBe(
      "run.sh",
    );
  });

  test("list_scripts handles an empty skill", async () => {
    const res = await call("list_scripts");
    expect((res.result as { content: { text: string }[] }).content[0]!.text).toBe(
      "(no script files in this skill)",
    );
  });

  test("run_script executes a script and captures stdout", async () => {
    await writeFile(
      join(skillDir, "run.sh"),
      "#!/bin/bash\necho \"hello $1\"\n",
      "utf8",
    );
    await chmod(join(skillDir, "run.sh"), 0o755);
    const res = await call("run_script", { script: "run.sh", args: ["world"] });
    const c = res.result as { content: { text: string }[]; isError: boolean };
    expect(c.content[0]!.text).toContain("hello world");
    expect(c.content[0]!.text).toContain("exit 0");
    expect(c.isError).toBe(false);
  });

  test("run_script reports a non-zero exit as error", async () => {
    await writeFile(join(skillDir, "fail.sh"), "exit 3", "utf8");
    const res = await call("run_script", { script: "fail.sh" });
    const c = res.result as { content: { text: string }[]; isError: boolean };
    expect(c.isError).toBe(true);
    expect(c.content[0]!.text).toContain("exit 3");
  });

  test("run_script rejects a missing script", async () => {
    const res = await call("run_script", { script: "nope.sh" });
    expect((res.result as { isError: boolean }).isError).toBe(true);
  });

  test("run_script rejects absolute / traversal / non-string", async () => {
    for (const s of ["/etc/passwd", "../x", "", 123 as unknown as string]) {
      const res = await call("run_script", { script: s });
      expect((res.result as { isError: boolean }).isError).toBe(true);
    }
  });

  test("run_script rejects an escaping symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "imp-out-"));
    try {
      await writeFile(join(outside, "evil.sh"), "echo pwned", "utf8");
      await symlink(join(outside, "evil.sh"), join(skillDir, "link.sh"));
      const res = await call("run_script", { script: "link.sh" });
      expect((res.result as { isError: boolean }).isError).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("run_script kills a script that exceeds the timeout", async () => {
    process.env.EZCORP_SKILL_RUN_TIMEOUT_MS = "60";
    await writeFile(join(skillDir, "slow.sh"), "sleep 5\n", "utf8");
    const res = await call("run_script", { script: "slow.sh" });
    expect((res.result as { isError: boolean }).isError).toBe(true);
  });

  test("unknown tool errors", async () => {
    const res = await call("nope");
    expect(res.error?.code).toBe(-32601);
  });

  test("defaulted params (no params object) are handled", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
    });
    expect(res.error?.code).toBe(-32601);
  });
});

describe("skill-runner: subprocess smoke", () => {
  test("synthesized extension answers JSON-RPC over stdio", async () => {
    const work = await mkdtemp(join(tmpdir(), "imp-spawn-"));
    try {
      const dir = await bundle(work, "skills/echo", "name: Echo", "do things");
      await writeFile(join(dir, "say.sh"), "#!/bin/bash\necho spoke\n", "utf8");
      await chmod(join(dir, "say.sh"), 0o755);
      const [b] = await scanSkillBundles(work);
      const destDir = join(work, "ext");
      await synthesizeSkillExtension({ bundle: b!, destDir, name: "echo" });

      const proc = Bun.spawn(["bun", join(destDir, "index.ts")], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) +
          "\n" +
          "not json\n" +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "run_script", arguments: { script: "say.sh" } },
          }) +
          "\n",
      );
      await proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const list = lines.find((l) => l.id === 1);
      const run = lines.find((l) => l.id === 2);
      expect(list.result.tools).toHaveLength(3);
      expect(run.result.content[0].text).toContain("spoke");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
