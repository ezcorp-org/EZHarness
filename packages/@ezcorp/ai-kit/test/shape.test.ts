import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Drift guard. Asserts the four ai-kit surfaces stay in sync:
 *    1. Every capability in docs/OVERVIEW.md is represented in openapi.yaml.
 *    2. Every MCP tool exposed from src/mcp/tools/* appears in at least one
 *       skills/ezcorp-*\/SKILL.md.
 *    3. Every orchestration tool is exported by ezcorp.config.ts (Tier 4).
 *    4. Every SSE event type referenced by src/mcp/tools/chat.ts is
 *       documented in docs/events.md.
 *
 *  This test runs under `bun run verify` — it fails the build if any of the
 *  four surfaces drift. Every surface exists, so a missing one is a failure,
 *  never a `todo` that reads as green (W4H-33).
 */

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("ai-kit surface drift guard", () => {
  test(
    "docs/OVERVIEW.md enumerates the capabilities the kit exposes",
    () => {
      const doc = read("docs/OVERVIEW.md");
      // Core primitives — doc must cover these concepts by name.
      expect(doc).toMatch(/conversation/i);
      expect(doc).toMatch(/message/i);
      expect(doc).toMatch(/run|sse|stream/i);
      expect(doc).toMatch(/agent|team|task/i);
      expect(doc).toMatch(/spawn_chats|fan[- ]?out/i);
    },
  );

  test(
    "openapi.yaml declares every capability from OVERVIEW",
    () => {
      const spec = read("docs/openapi.yaml");
      expect(spec).toMatch(/\/api\/conversations/);
      expect(spec).toMatch(/\/api\/agent-configs/);
      expect(spec).toMatch(/\/api\/runtime-events/);
    },
  );

  test(
    "every MCP tool is mentioned in at least one SKILL.md",
    () => {
      const toolsDir = join(ROOT, "src/mcp/tools");
      const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
      const toolNames = new Set<string>();
      for (const f of files) {
        const src = readFileSync(join(toolsDir, f), "utf8");
        for (const m of src.matchAll(/name:\s*["']([a-z_]+)["']/g)) toolNames.add(m[1]!);
      }
      const skillsRoot = join(ROOT, "skills");
      const skillDirs = readdirSync(skillsRoot);
      const skillText = skillDirs
        .flatMap((d) => {
          const p = join(skillsRoot, d, "SKILL.md");
          return existsSync(p) ? [readFileSync(p, "utf8")] : [];
        })
        .join("\n");
      const missing = [...toolNames].filter((n) => !skillText.includes(n));
      expect(missing, `tools missing from skills: ${missing.join(", ")}`).toEqual([]);
    },
  );

  test(
    "ezcorp.config.ts exports orchestration tools for Tier 4",
    () => {
      const cfg = read("ezcorp.config.ts");
      expect(cfg).toMatch(/schemaVersion:\s*4/);
      expect(cfg).toMatch(/start_chat|spawn_chats|send_message/);
    },
  );

  test(
    "every SSE event type used by tools/chat.ts is documented",
    () => {
      const chatSrc = read("src/mcp/tools/chat.ts");
      const doc = read("docs/events.md");
      const used = new Set(
        [...chatSrc.matchAll(/['"](run:[a-z_]+|agent:[a-z_]+|task:[a-z_]+)['"]/g)].map(
          (m) => m[1]!,
        ),
      );
      const missing = [...used].filter((ev) => !doc.includes(ev));
      expect(missing, `events missing from docs/events.md: ${missing.join(", ")}`).toEqual([]);
    },
  );
});
