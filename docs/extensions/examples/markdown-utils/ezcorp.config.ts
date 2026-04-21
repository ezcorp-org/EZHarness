import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "markdown-utils",
  version: "1.0.0",
  description: "Markdown formatting tools, style guidelines, and an editing assistant in one package",
  author: {
    name: "EzCorp",
  },
  entrypoint: "./index.ts",
  persistent: true,
  tools: [
    {
      name: "format-table",
      description: "Convert rows and headers into a formatted markdown table",
      inputSchema: {
        type: "object",
        properties: {
          headers: {
            type: "array",
            items: { type: "string" },
            description: "Column header names",
          },
          rows: {
            type: "array",
            items: {
              type: "array",
              items: { type: "string" },
            },
            description: "Table rows as arrays of cell values",
          },
        },
        required: ["headers", "rows"],
      },
    },
    {
      name: "extract-headings",
      description: "Parse markdown text and return the heading hierarchy",
      inputSchema: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description: "Markdown text to parse",
          },
        },
        required: ["markdown"],
      },
    },
  ],
  skills: [
    {
      name: "markdown-style",
      description: "Guidelines for writing clean, consistent markdown",
      content: "# Markdown Style Guide\n\n- Use ATX-style headings (# not underlines)\n- One sentence per line for better diffs\n- Blank line before and after headings, lists, and code blocks\n- Use fenced code blocks with language identifiers\n- Prefer reference-style links for repeated URLs\n- Tables: align pipes, use header separator row\n- Lists: consistent marker (- not mixed with *)\n- Maximum line length: 120 characters for prose",
    },
  ],
  agent: {
    prompt: "You are a markdown editing assistant. Help users format, restructure, and improve their markdown documents. Follow the markdown-style skill guidelines. When reformatting, explain what you changed and why.",
    category: "Writing",
  },
  permissions: {},
});
