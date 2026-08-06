import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Shared types & utilities ──────────────────────────────────────────
//
// THIS SUITE ASSERTS ONLY ON DATA IT CREATES. It used to end with a "live
// memory" section that read `$HOME/.claude/projects/<checkout>/memory` — the
// developer's own agent-memory directory — and asserted that every file there
// carried one of four `type` values, a <150-char description, a snake_case
// filename, and so on. That directory is external to the repo, user-managed,
// and read by nothing in `src/`: the product's persistent memory is the
// `memories` table (docs/features/chat/persistent-memory.md), not those files.
// So the section could only ever fail on one person's laptop because of one
// person's notes, and in CI (and any fresh worktree) the directory is absent,
// which made every case vacuous. The conventions it meant to police are now
// asserted against fixtures below, where they can fail for a real reason.

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);
const MAX_DESCRIPTION_LENGTH = 150;
const SNAKE_CASE_FILE = /^[a-z][a-z0-9_]*\.md$/;
const INDEX_ENTRY = /^- \[.+\]\(.+\.md\) — .+$/;

interface Frontmatter {
  name: string;
  description: string;
  type: string;
  [key: string]: string;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const pairs: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    pairs[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }

  return {
    frontmatter: pairs as Frontmatter,
    body: match[2]!,
  };
}

function buildMemoryFile(fm: Partial<Frontmatter>, body: string): string {
  const lines = [];
  if (fm.name) lines.push(`name: ${fm.name}`);
  if (fm.description) lines.push(`description: ${fm.description}`);
  if (fm.type) lines.push(`type: ${fm.type}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function buildIndex(entries: { title: string; file: string; hook: string }[]): string {
  const lines = ["# Project Memory\n"];
  for (const e of entries) {
    lines.push(`- [${e.title}](${e.file}) — ${e.hook}`);
  }
  return lines.join("\n") + "\n";
}

function extractLinkedFiles(indexContent: string): string[] {
  const linkPattern = /\[.*?\]\((.*?\.md)\)/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(indexContent)) !== null) {
    files.push(m[1]!);
  }
  return files;
}

/**
 * Every convention a single memory file must satisfy, stated ONCE. Returns one
 * problem code per violation; an empty array means the file conforms.
 */
function validateMemoryFile(file: string, content: string): string[] {
  const problems: string[] = [];
  if (!SNAKE_CASE_FILE.test(file)) problems.push("filename-not-snake-case");

  const { frontmatter, body } = parseFrontmatter(content);
  if (!frontmatter) {
    problems.push("missing-frontmatter");
    return problems;
  }

  if (!frontmatter.name) problems.push("missing-name");
  else if (frontmatter.name !== file.replace(/\.md$/, "")) problems.push("name-filename-mismatch");

  if (!frontmatter.description) problems.push("missing-description");
  else if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH)
    problems.push("description-too-long");

  if (!frontmatter.type) problems.push("missing-type");
  else if (!VALID_TYPES.has(frontmatter.type)) problems.push("invalid-type");

  if (body.trim().length === 0) problems.push("empty-body");
  return problems;
}

/**
 * Every convention a MEMORY.md index must satisfy against the files sitting
 * beside it. The index is a CURATED SUBSET — compaction merges/drops index
 * lines while the underlying files persist for graph-link reachability — so it
 * may link FEWER files than exist, never more, never the same file twice, and
 * never a file that isn't there.
 */
function validateIndex(indexContent: string, memoryFiles: string[]): string[] {
  const problems: string[] = [];
  if (indexContent.startsWith("---")) problems.push("index-has-frontmatter");
  else if (!indexContent.startsWith("#")) problems.push("index-missing-heading");

  for (const line of indexContent.split("\n").filter(l => l.startsWith("- ["))) {
    if (!INDEX_ENTRY.test(line)) problems.push("malformed-entry");
    if (line.length > MAX_DESCRIPTION_LENGTH) problems.push("entry-too-long");
  }

  const linked = extractLinkedFiles(indexContent);
  if (new Set(linked).size !== linked.length) problems.push("duplicate-link");
  if (linked.length > memoryFiles.length) problems.push("index-links-more-than-exist");
  for (const f of linked) {
    if (!memoryFiles.includes(f)) problems.push("broken-link");
  }
  return problems;
}

// ══════════════════════════════════════════════════════════════════════
// UNIT TESTS — parseFrontmatter edge cases
// ══════════════════════════════════════════════════════════════════════

describe("parseFrontmatter — unit tests", () => {
  test("parses valid frontmatter", () => {
    const content = "---\nname: test\ndescription: a test\ntype: project\n---\nBody here";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.name).toBe("test");
    expect(frontmatter!.description).toBe("a test");
    expect(frontmatter!.type).toBe("project");
    expect(body).toBe("Body here");
  });

  test("returns null frontmatter for content without delimiters", () => {
    const { frontmatter, body } = parseFrontmatter("Just plain text\nNo frontmatter");
    expect(frontmatter).toBeNull();
    expect(body).toBe("Just plain text\nNo frontmatter");
  });

  test("returns null frontmatter for empty string", () => {
    const { frontmatter, body } = parseFrontmatter("");
    expect(frontmatter).toBeNull();
    expect(body).toBe("");
  });

  test("handles missing fields gracefully", () => {
    const content = "---\nname: only-name\n---\nBody";
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.name).toBe("only-name");
    expect(frontmatter!.description).toBeUndefined();
    expect(frontmatter!.type).toBeUndefined();
  });

  test("handles extra fields", () => {
    const content = "---\nname: test\ndescription: d\ntype: user\ncustom: extra\n---\nBody";
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.custom).toBe("extra");
  });

  test("handles colons in values", () => {
    const content = "---\nname: test\ndescription: key: value pair here\ntype: project\n---\nBody";
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.description).toBe("key: value pair here");
  });

  test("handles empty body after frontmatter", () => {
    const content = "---\nname: test\ntype: user\n---\n";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(body).toBe("");
  });

  test("handles single opening delimiter without closing", () => {
    const content = "---\nname: test\nNo closing delimiter";
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
  });

  test("handles lines without colons in frontmatter", () => {
    const content = "---\nname: test\nno-colon-line\ntype: user\n---\nBody";
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.name).toBe("test");
    expect(frontmatter!.type).toBe("user");
  });

  test("handles whitespace in keys and values", () => {
    const content = "---\n  name  :  spaced  \ntype: project\n---\nBody";
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.name).toBe("spaced");
    expect(frontmatter!.type).toBe("project");
  });

  test("handles multiline body content", () => {
    const content = "---\nname: test\ntype: user\n---\nLine 1\nLine 2\nLine 3";
    const { body } = parseFrontmatter(content);
    expect(body).toBe("Line 1\nLine 2\nLine 3");
  });
});

// ══════════════════════════════════════════════════════════════════════
// UNIT TESTS — buildMemoryFile & buildIndex helpers
// ══════════════════════════════════════════════════════════════════════

describe("memory file builders — unit tests", () => {
  test("buildMemoryFile creates valid frontmatter content", () => {
    const content = buildMemoryFile(
      { name: "test", description: "a desc", type: "project" },
      "\nSome body content\n"
    );
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter!.name).toBe("test");
    expect(frontmatter!.description).toBe("a desc");
    expect(frontmatter!.type).toBe("project");
    expect(body.trim()).toBe("Some body content");
  });

  test("buildIndex creates valid markdown links", () => {
    const index = buildIndex([
      { title: "Foo", file: "foo.md", hook: "Description of foo" },
      { title: "Bar", file: "bar.md", hook: "Description of bar" },
    ]);
    expect(index).toContain("- [Foo](foo.md) — Description of foo");
    expect(index).toContain("- [Bar](bar.md) — Description of bar");
  });

  test("extractLinkedFiles extracts file references from index", () => {
    const index = "- [A](a.md) — desc\n- [B](b.md) — desc\n";
    const files = extractLinkedFiles(index);
    expect(files).toEqual(["a.md", "b.md"]);
  });

  test("extractLinkedFiles returns empty for no links", () => {
    const files = extractLinkedFiles("# Just a heading\nNo links here.");
    expect(files).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — memory CRUD lifecycle (temp directory)
// ══════════════════════════════════════════════════════════════════════

describe("memory CRUD lifecycle — integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memory-test-"));
  });

  afterAll(async () => {
    // Clean up any leftover temp dirs (best effort)
  });

  test("create memory file and verify structure", async () => {
    const content = buildMemoryFile(
      { name: "test_mem", description: "A test memory", type: "project" },
      "\n- Item 1\n- Item 2\n"
    );
    const filePath = join(tmpDir, "test_mem.md");
    await writeFile(filePath, content);

    const readBack = await Bun.file(filePath).text();
    const { frontmatter, body } = parseFrontmatter(readBack);

    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.name).toBe("test_mem");
    expect(frontmatter!.description).toBe("A test memory");
    expect(frontmatter!.type).toBe("project");
    expect(body.trim()).toContain("Item 1");
  });

  test("create index with multiple memory files and verify references", async () => {
    const files = [
      { name: "overview", desc: "Project overview", type: "project", body: "\n- Overview content\n" },
      { name: "prefs", desc: "User preferences", type: "user", body: "\n- Prefs content\n" },
    ];

    for (const f of files) {
      const content = buildMemoryFile({ name: f.name, description: f.desc, type: f.type }, f.body);
      await writeFile(join(tmpDir, `${f.name}.md`), content);
    }

    const index = buildIndex([
      { title: "Overview", file: "overview.md", hook: "Project overview" },
      { title: "Preferences", file: "prefs.md", hook: "User preferences" },
    ]);
    await writeFile(join(tmpDir, "MEMORY.md"), index);

    // Verify all files exist
    const entries = await readdir(tmpDir);
    expect(entries).toContain("MEMORY.md");
    expect(entries).toContain("overview.md");
    expect(entries).toContain("prefs.md");

    // Verify index links resolve
    const indexContent = await Bun.file(join(tmpDir, "MEMORY.md")).text();
    const linkedFiles = extractLinkedFiles(indexContent);
    const memFiles = entries.filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    for (const linked of linkedFiles) {
      expect(memFiles).toContain(linked);
    }
    expect(linkedFiles.length).toBe(memFiles.length);
  });

  test("update memory file preserves structure", async () => {
    const original = buildMemoryFile(
      { name: "updatable", description: "Original desc", type: "feedback" },
      "\n- Original content\n"
    );
    const filePath = join(tmpDir, "updatable.md");
    await writeFile(filePath, original);

    // Update the file
    const updated = buildMemoryFile(
      { name: "updatable", description: "Updated desc", type: "feedback" },
      "\n- Updated content\n- New item\n"
    );
    await writeFile(filePath, updated);

    const readBack = await Bun.file(filePath).text();
    const { frontmatter, body } = parseFrontmatter(readBack);
    expect(frontmatter!.description).toBe("Updated desc");
    expect(body).toContain("Updated content");
    expect(body).toContain("New item");
    expect(body).not.toContain("Original content");
  });

  test("delete memory file and update index", async () => {
    // Create two files + index
    await writeFile(join(tmpDir, "keep.md"), buildMemoryFile({ name: "keep", description: "Keep", type: "project" }, "\nKeep\n"));
    await writeFile(join(tmpDir, "remove.md"), buildMemoryFile({ name: "remove", description: "Remove", type: "project" }, "\nRemove\n"));
    await writeFile(join(tmpDir, "MEMORY.md"), buildIndex([
      { title: "Keep", file: "keep.md", hook: "Keep this" },
      { title: "Remove", file: "remove.md", hook: "Remove this" },
    ]));

    // Delete file and rebuild index
    await rm(join(tmpDir, "remove.md"));
    await writeFile(join(tmpDir, "MEMORY.md"), buildIndex([
      { title: "Keep", file: "keep.md", hook: "Keep this" },
    ]));

    const entries = await readdir(tmpDir);
    expect(entries).not.toContain("remove.md");
    expect(entries).toContain("keep.md");

    const indexContent = await Bun.file(join(tmpDir, "MEMORY.md")).text();
    expect(indexContent).not.toContain("remove.md");
    expect(indexContent).toContain("keep.md");
  });

  test("detects orphaned files not in index", async () => {
    await writeFile(join(tmpDir, "indexed.md"), buildMemoryFile({ name: "indexed", description: "In index", type: "project" }, "\nContent\n"));
    await writeFile(join(tmpDir, "orphan.md"), buildMemoryFile({ name: "orphan", description: "Not in index", type: "project" }, "\nContent\n"));
    await writeFile(join(tmpDir, "MEMORY.md"), buildIndex([
      { title: "Indexed", file: "indexed.md", hook: "In index" },
    ]));

    const entries = await readdir(tmpDir);
    const memFiles = entries.filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    const indexContent = await Bun.file(join(tmpDir, "MEMORY.md")).text();
    const linkedFiles = extractLinkedFiles(indexContent);

    const orphaned = memFiles.filter(f => !linkedFiles.includes(f));
    expect(orphaned).toEqual(["orphan.md"]);
  });

  test("detects broken links in index", async () => {
    await writeFile(join(tmpDir, "exists.md"), buildMemoryFile({ name: "exists", description: "Exists", type: "project" }, "\nContent\n"));
    await writeFile(join(tmpDir, "MEMORY.md"), buildIndex([
      { title: "Exists", file: "exists.md", hook: "Exists" },
      { title: "Missing", file: "missing.md", hook: "Does not exist" },
    ]));

    const entries = await readdir(tmpDir);
    const memFiles = entries.filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    const indexContent = await Bun.file(join(tmpDir, "MEMORY.md")).text();
    const linkedFiles = extractLinkedFiles(indexContent);

    const broken = linkedFiles.filter(f => !memFiles.includes(f));
    expect(broken).toEqual(["missing.md"]);
  });

  test("validates all type values in a set of files", async () => {
    const types = ["user", "feedback", "project", "reference"];
    for (const t of types) {
      await writeFile(join(tmpDir, `${t}.md`), buildMemoryFile({ name: t, description: `Type ${t}`, type: t }, `\n${t} content\n`));
    }

    const entries = await readdir(tmpDir);
    for (const file of entries.filter(f => f.endsWith(".md"))) {
      const content = await Bun.file(join(tmpDir, file)).text();
      const { frontmatter } = parseFrontmatter(content);
      expect(VALID_TYPES.has(frontmatter!.type)).toBe(true);
    }
  });

  test("rejects invalid type", async () => {
    await writeFile(join(tmpDir, "bad.md"), buildMemoryFile({ name: "bad", description: "Bad type", type: "invalid" }, "\nContent\n"));

    const content = await Bun.file(join(tmpDir, "bad.md")).text();
    const { frontmatter } = parseFrontmatter(content);
    expect(VALID_TYPES.has(frontmatter!.type)).toBe(false);
  });

  test("detects duplicate names across files", async () => {
    await writeFile(join(tmpDir, "a.md"), buildMemoryFile({ name: "dupe", description: "First", type: "project" }, "\nContent\n"));
    await writeFile(join(tmpDir, "b.md"), buildMemoryFile({ name: "dupe", description: "Second", type: "project" }, "\nContent\n"));

    const entries = await readdir(tmpDir);
    const names: string[] = [];
    for (const file of entries.filter(f => f.endsWith(".md"))) {
      const content = await Bun.file(join(tmpDir, file)).text();
      const { frontmatter } = parseFrontmatter(content);
      if (frontmatter?.name) names.push(frontmatter.name);
    }
    expect(new Set(names).size).toBeLessThan(names.length);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CONVENTION VALIDATION — the memory-file rules, on repo-owned fixtures
// ══════════════════════════════════════════════════════════════════════
//
// These replace the deleted "live memory" section (see the header note). Same
// rules, applied to files this suite writes, so a violation is a real finding
// instead of a report on whoever ran the suite. Three of them
// (description length, index line length, name-matches-filename) were dead
// `test.skip`s there precisely because external data drifts; against fixtures
// they are ordinary assertions again.

describe("memory file conventions — validateMemoryFile", () => {
  test("accepts a conforming file of every valid type", () => {
    for (const type of VALID_TYPES) {
      const file = `${type}_notes.md`;
      const content = buildMemoryFile(
        { name: `${type}_notes`, description: `A ${type} memory`, type },
        "\n- Body content\n"
      );
      expect(validateMemoryFile(file, content)).toEqual([]);
    }
  });

  test("flags a filename that is not snake_case", () => {
    const content = buildMemoryFile({ name: "MyNotes", description: "d", type: "user" }, "\nBody\n");
    expect(validateMemoryFile("MyNotes.md", content)).toContain("filename-not-snake-case");
  });

  test("flags content with no frontmatter, and reports nothing further", () => {
    const problems = validateMemoryFile("notes.md", "Just a body, no frontmatter\n");
    expect(problems).toEqual(["missing-frontmatter"]);
  });

  test("flags a name that does not match the filename", () => {
    const content = buildMemoryFile({ name: "other", description: "d", type: "user" }, "\nBody\n");
    expect(validateMemoryFile("notes.md", content)).toEqual(["name-filename-mismatch"]);
  });

  test("flags each missing required field", () => {
    const content = buildMemoryFile({ name: "notes" }, "\nBody\n");
    const problems = validateMemoryFile("notes.md", content);
    expect(problems).toContain("missing-description");
    expect(problems).toContain("missing-type");
    expect(problems).not.toContain("missing-name");
  });

  test("flags a description over the cap but accepts one exactly at it", () => {
    const atCap = "x".repeat(MAX_DESCRIPTION_LENGTH);
    const overCap = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    const ok = buildMemoryFile({ name: "notes", description: atCap, type: "user" }, "\nBody\n");
    const bad = buildMemoryFile({ name: "notes", description: overCap, type: "user" }, "\nBody\n");
    expect(validateMemoryFile("notes.md", ok)).toEqual([]);
    expect(validateMemoryFile("notes.md", bad)).toEqual(["description-too-long"]);
  });

  test("flags a type outside the allowed set", () => {
    const content = buildMemoryFile(
      { name: "notes", description: "d", type: "insight" },
      "\nBody\n"
    );
    expect(validateMemoryFile("notes.md", content)).toEqual(["invalid-type"]);
  });

  test("flags a file whose body is empty or whitespace only", () => {
    const content = buildMemoryFile({ name: "notes", description: "d", type: "user" }, "\n   \n");
    expect(validateMemoryFile("notes.md", content)).toEqual(["empty-body"]);
  });

  test("reports every violation in one pass", () => {
    const content = buildMemoryFile(
      { name: "wrong", description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1), type: "bogus" },
      "\n\n"
    );
    expect(validateMemoryFile("BadName.md", content).sort()).toEqual([
      "description-too-long",
      "empty-body",
      "filename-not-snake-case",
      "invalid-type",
      "name-filename-mismatch",
    ]);
  });

  test("validates files round-tripped through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-conv-"));
    await writeFile(
      join(dir, "good.md"),
      buildMemoryFile({ name: "good", description: "Fine", type: "project" }, "\nBody\n")
    );
    await writeFile(
      join(dir, "bad.md"),
      buildMemoryFile({ name: "bad", description: "Nope", type: "nonsense" }, "\nBody\n")
    );

    const entries = (await readdir(dir)).filter(f => f.endsWith(".md")).sort();
    const problems = new Map<string, string[]>();
    for (const file of entries) {
      problems.set(file, validateMemoryFile(file, await Bun.file(join(dir, file)).text()));
    }

    expect(problems.get("good.md")).toEqual([]);
    expect(problems.get("bad.md")).toEqual(["invalid-type"]);
    await rm(dir, { recursive: true });
  });
});

describe("MEMORY.md index conventions — validateIndex", () => {
  const conformingIndex = buildIndex([
    { title: "Alpha", file: "alpha.md", hook: "About alpha" },
    { title: "Beta", file: "beta.md", hook: "About beta" },
  ]);

  test("accepts a conforming index", () => {
    expect(validateIndex(conformingIndex, ["alpha.md", "beta.md"])).toEqual([]);
  });

  test("accepts an index that links a subset of the files present", () => {
    expect(validateIndex(conformingIndex, ["alpha.md", "beta.md", "gamma.md"])).toEqual([]);
  });

  test("flags an index that opens with frontmatter", () => {
    expect(validateIndex(`---\ntype: index\n---\n${conformingIndex}`, ["alpha.md", "beta.md"])).toEqual([
      "index-has-frontmatter",
    ]);
  });

  test("flags an index that does not start with a heading", () => {
    const noHeading = conformingIndex.replace("# Project Memory", "Project Memory");
    expect(validateIndex(noHeading, ["alpha.md", "beta.md"])).toEqual(["index-missing-heading"]);
  });

  test("flags an entry line that is not a markdown link with a hook", () => {
    const malformed = "# Project Memory\n\n- [Alpha](alpha.md)\n";
    expect(validateIndex(malformed, ["alpha.md"])).toEqual(["malformed-entry"]);
  });

  test("flags an entry line over the length cap", () => {
    const long = buildIndex([
      { title: "Alpha", file: "alpha.md", hook: "y".repeat(MAX_DESCRIPTION_LENGTH) },
    ]);
    expect(validateIndex(long, ["alpha.md"])).toEqual(["entry-too-long"]);
  });

  test("flags the same file linked twice", () => {
    const dupe = buildIndex([
      { title: "Alpha", file: "alpha.md", hook: "About alpha" },
      { title: "Alpha again", file: "alpha.md", hook: "Also about alpha" },
    ]);
    expect(validateIndex(dupe, ["alpha.md", "beta.md"])).toEqual(["duplicate-link"]);
  });

  test("flags a link with no file behind it", () => {
    expect(validateIndex(conformingIndex, ["alpha.md", "other.md"])).toEqual(["broken-link"]);
  });

  test("flags an index linking more files than exist", () => {
    expect(validateIndex(conformingIndex, ["alpha.md"]).sort()).toEqual([
      "broken-link",
      "index-links-more-than-exist",
    ]);
  });
});
