// Stub manifest mirroring the real substack-pilot extension shape, used
// by `substack-pilot-chat-e2e.test.ts` to register the extension in the
// test DB without pulling in the real `docs/extensions/examples/.../ezcorp.config.ts`
// (which declares mcpServers + scripts + skills the test doesn't need).
//
// Tool names + inputSchema shapes match the production manifest verbatim
// so the MockAgent's tool_use frames hit the same code paths as a real
// LLM would.

import { defineExtension } from "../../../extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "substack-pilot",
  version: "1.0.0",
  description: "Stub substack-pilot used by chat-E2E tests.",
  author: { name: "Test" },
  entrypoint: "./entrypoint.ts",
  persistent: false,
  tools: [
    {
      name: "list_post_types",
      description: "List post types.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_post_type",
      description: "Fetch a post type by slug.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
    {
      name: "create_post_type",
      description: "Create a post type.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          systemPrompt: { type: "string" },
        },
        required: ["name", "slug", "systemPrompt"],
      },
    },
    {
      name: "update_post_type",
      description: "Update a post type.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          patch: { type: "object" },
        },
        required: ["slug", "patch"],
      },
    },
    {
      name: "delete_post_type",
      description: "Delete a post type by slug.",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
    {
      name: "summarize_urls",
      description: "Summarize a list of URLs.",
      inputSchema: {
        type: "object",
        properties: {
          urls: { type: "array", items: { type: "string" } },
        },
        required: ["urls"],
      },
    },
    {
      name: "generate_substack_draft",
      description: "Generate and create a Substack draft from URLs.",
      inputSchema: {
        type: "object",
        properties: {
          postTypeSlug: { type: "string" },
          urls: { type: "array", items: { type: "string" } },
        },
        required: ["postTypeSlug", "urls"],
      },
    },
  ],
  permissions: {},
});
