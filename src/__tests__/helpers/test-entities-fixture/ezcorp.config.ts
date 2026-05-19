// ── test-entities-fixture — minimal entity-only extension ───────
//
// Phase 8 of the defineEntity SDK. Installed from
// `src/__tests__/helpers/test-entities-fixture/` by
// `entities-e2e.test.ts` to exercise the full install → seed →
// dispatch → CRUD round-trip in isolation from substack-pilot's
// LLM / MCP machinery.
//
// One entity declaration, no tools, no MCP, no LLM. Two seed
// records read from `prompts/*.txt` via `{file:...}` placeholders
// so we also cover the Phase 6 file-resolver in the e2e path.

import { defineExtension } from "../../../extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "test-entities-fixture",
  version: "1.0.0",
  description: "Fixture extension for end-to-end entity tests.",
  author: { name: "EZCorp Tests" },
  // The host's `installFromLocal` requires an entrypoint; this stub
  // is never actually executed at runtime because all of the
  // extension's tools are SDK-served (entity CRUD) and short-circuit
  // before reaching the subprocess. See `./index.ts` for the throw
  // guard that surfaces a regression if dispatch ever tried to spawn
  // this fixture.
  entrypoint: "./index.ts",
  permissions: {
    storage: true,
  },
  entities: [
    {
      type: "note",
      label: "Note",
      pluralLabel: "Notes",
      scope: "user",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 100 },
          body: { type: "string", minLength: 1, maxLength: 10_000 },
          pinned: { type: "boolean" },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
      preview: "{title}",
      seed: [
        {
          slug: "first",
          data: {
            title: "First Note",
            body: "{file:./prompts/first.txt}",
            pinned: true,
          },
        },
        {
          slug: "second",
          data: {
            title: "Second Note",
            body: "{file:./prompts/second.txt}",
          },
        },
      ],
    },
  ],
});
