import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "excel",
  version: "0.1.0",
  description:
    "Read Excel (.xlsx) workbooks attached to chat. Provides a `read-spreadsheet` tool that returns a sheet manifest, range reads in A1 notation, or full sheets rendered as markdown tables. Operates on attachment handles — no separate disk path required.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  acceptedAttachmentMimes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  tools: [
    {
      name: "read-spreadsheet",
      description:
        "Inspect or read content from an attached Excel workbook. Call once with mode=manifest to discover sheet names, dimensions, headers, and a few sample rows; then call with mode=range and an A1 range (e.g. 'A1:F50') for targeted reads, or mode=sheet to dump a full sheet as a markdown table. The `source` argument must be an `ez-attachment://<id>` handle taken verbatim from the `<file>` block in the user message — the runtime will substitute the bytes automatically.",
      inputSchema: {
        type: "object",
        required: ["source", "mode"],
        properties: {
          source: {
            type: "string",
            description:
              "Attachment handle, e.g. `ez-attachment://abc-123`. Pass the handle string verbatim — the runtime substitutes it to a `data:` URI before this tool sees it.",
          },
          mode: {
            type: "string",
            enum: ["manifest", "sheet", "range"],
            description:
              "manifest: list sheets with dims + first 5 rows. sheet: render the named sheet as a markdown table. range: render an A1 range from the named sheet.",
          },
          sheet: {
            type: "string",
            description: "Sheet name. Required for mode=sheet and mode=range.",
          },
          range: {
            type: "string",
            description: "A1 notation, e.g. 'A1:F100'. Required for mode=range.",
          },
          maxRows: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            default: 1000,
            description: "Per-sheet row cap. Output is truncated past this with a marker.",
          },
        },
      },
    },
  ],
  permissions: {},
  resources: { memory: "256MB", callTimeoutMs: 30000 },
});
