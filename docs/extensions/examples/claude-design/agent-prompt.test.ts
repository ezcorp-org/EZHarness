// Guardrail: pin the load-bearing clauses in the claude-design agent
// prompt that fix the "agent answers itself instead of calling
// clarify-brief" bug. If a future refactor weakens the prompt and
// silently drops one of these clauses, this test fails.
//
// We import the manifest module directly so we evaluate the joined
// `[…lines].join("\n")` string the runtime actually loads — that's
// the surface the model sees, not the file source.

import { test, expect, describe } from "bun:test";
import config from "./ezcorp.config";

interface ManifestShape {
  agent?: { prompt?: string };
  tools?: Array<{
    name?: string;
    inputSchema?: { properties?: Record<string, { description?: string }> };
  }>;
}

const manifest = config as unknown as ManifestShape;
const PROMPT = manifest.agent?.prompt ?? "";

describe("claude-design agent prompt — clarify-brief gate clauses", () => {
  test("manifest exports a non-empty agent.prompt", () => {
    expect(typeof PROMPT).toBe("string");
    expect(PROMPT.length).toBeGreaterThan(500);
  });

  test("declares 'DEFAULT TO ASKING' (default-to-clarify posture)", () => {
    expect(PROMPT).toContain("DEFAULT TO ASKING");
  });

  test("requires ALL FOUR signals before allowing skip", () => {
    expect(PROMPT).toContain("ALL FOUR");
  });

  test("calls out the four signal categories: tone, audience, sections, brand colors", () => {
    expect(PROMPT).toMatch(/tone keyword/i);
    expect(PROMPT).toMatch(/audience signal/i);
    expect(PROMPT).toMatch(/at least ONE section/i);
    expect(PROMPT).toMatch(/brand colors/i);
  });

  test("forbids 'answering yourself' as a shortcut for asking", () => {
    // Phrase spans two source lines joined by '\n   ' in the runtime
    // prompt — match across whitespace including newlines.
    expect(PROMPT).toMatch(/answering[\s]+yourself/i);
  });

  test("requires a justification sentence when skipping clarify-brief", () => {
    expect(PROMPT).toMatch(/Skipping clarify-brief/i);
    expect(PROMPT).toMatch(/quoting which signals/i);
  });
});

describe("claude-design manifest — generate-design schema includes skipBriefReason", () => {
  test("schema declares skipBriefReason as an optional string property", () => {
    const tool = manifest.tools?.find((t) => t.name === "generate-design");
    expect(tool).toBeTruthy();
    const props = tool?.inputSchema?.properties ?? {};
    expect(props.skipBriefReason).toBeTruthy();
    // Description references the gate behavior.
    const desc = props.skipBriefReason?.description ?? "";
    expect(desc).toMatch(/only set when you skipped clarify-brief/i);
    expect(desc).toContain("toolError");
  });
});
