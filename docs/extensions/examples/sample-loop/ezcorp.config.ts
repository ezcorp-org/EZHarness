// sample-loop — the reference Loop SDK primitive example manifest.
//
// Declares the one trigger the loop wires (run:complete) + the grants a
// terminal capture loop needs: an LLM provider, storage (the run store),
// and a filesystem path for the artifact mirror.

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "sample-loop",
  version: "1.0.0",
  description:
    "Reference Loop SDK example — summarizes each completed chat run in one line and mirrors it to an artifact, built on defineLoop.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Examples",
  tags: ["loop", "example", "reference"],
  // Event-only loop — stay resident so run:complete isn't dropped on idle.
  persistent: true,

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Summarize each completed chat run.",
      default: true,
    },
    provider: {
      type: "select",
      label: "Model provider",
      options: [
        { value: "google", label: "Google" },
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
      ],
      default: "google",
    },
    model: {
      type: "text",
      label: "Model id (override)",
      default: "",
    },
  },

  permissions: {
    llm: {
      providers: ["google", "openai", "anthropic"],
      maxCallsPerHour: 30,
      maxCallsPerDay: 200,
      maxTokensPerCall: 128,
    },
    eventSubscriptions: ["run:complete"],
    storage: true,
    // The artifact mirror lands under .ezcorp/extension-data/summarize/.
    filesystem: ["$CWD"],
  },

  resources: { memory: "128MB" },
});
