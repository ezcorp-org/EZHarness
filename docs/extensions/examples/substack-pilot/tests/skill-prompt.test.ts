import { test, expect, describe } from "bun:test";
import { join } from "node:path";

// The SKILL.md content is what the LLM actually sees when the
// `substack-author` skill is loaded into a conversation. These
// assertions guard against accidental tool-name drift between
// the manifest and the skill, and against the skill losing the
// example snippets the LLM uses for syntax cues.

const SKILL_PATH = join(
  import.meta.dir,
  "..",
  "skills",
  "substack-author",
  "SKILL.md",
);

const TOOL_NAMES = [
  "list_post_types",
  "get_post_type",
  "create_post_type",
  "update_post_type",
  "delete_post_type",
  "summarize_urls",
  "generate_substack_draft",
];

describe("substack-author SKILL.md", () => {
  test("file exists and is non-empty", async () => {
    const f = Bun.file(SKILL_PATH);
    expect(await f.exists()).toBe(true);
    const txt = await f.text();
    expect(txt.length).toBeGreaterThan(500);
  });

  test("mentions every tool by name", async () => {
    const txt = await Bun.file(SKILL_PATH).text();
    for (const name of TOOL_NAMES) {
      expect(txt).toContain(name);
    }
  });

  test("teaches the canonical flow (get_post_type → generate_substack_draft)", async () => {
    const txt = await Bun.file(SKILL_PATH).text();
    const getIdx = txt.indexOf("get_post_type");
    const genIdx = txt.indexOf("generate_substack_draft");
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(genIdx).toBeGreaterThanOrEqual(0);
    expect(getIdx).toBeLessThan(genIdx); // get_post_type appears first
  });

  test("uses the `{slug}` placeholder syntax in at least one example", async () => {
    const txt = await Bun.file(SKILL_PATH).text();
    // The skill shows JSON-arg examples like { slug: "weekly" } and
    // a token form `![ext:substack-pilot]`. Either is acceptable as
    // the slug placeholder cue.
    const hasSlugArg = /slug:\s*["']/.test(txt);
    const hasExtToken = txt.includes("![ext:substack-pilot]");
    expect(hasSlugArg || hasExtToken).toBe(true);
  });

  test("warns about deletion confirmation", async () => {
    const txt = await Bun.file(SKILL_PATH).text();
    // The skill must tell the LLM to read back + confirm before deleting,
    // matching the spec's "soft-confirm flow".
    expect(txt.toLowerCase()).toContain("delete");
    expect(txt.toLowerCase()).toMatch(/confirm/);
  });

  test("flags publishing as out of scope", async () => {
    const txt = await Bun.file(SKILL_PATH).text();
    // Spec locks "draft-only"; the skill must say this so the LLM never
    // claims a draft was published.
    expect(txt.toLowerCase()).toContain("draft");
    expect(txt.toLowerCase()).toMatch(/(out of scope|don'?t promise|review and publish)/);
  });

  test("lists every tool in the contract table", async () => {
    const txt = await Bun.file(SKILL_PATH).text();
    // The "What the extension exposes" table contains one row per tool.
    // Count occurrences in a markdown-table line (`| <tool> ...`).
    for (const name of TOOL_NAMES) {
      // Use the back-tick form `\`<name>\`` to match the table row.
      const re = new RegExp("`" + name + "`");
      expect(re.test(txt)).toBe(true);
    }
  });
});
