import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "web-search",
  version: "1.0.0",
  description:
    "Web search and URL-to-markdown reader. Forwards to the host `ctx.search` " +
    "capability (keyless by default via the bundled SearXNG sidecar with DuckDuckGo " +
    "fallback; BYOK providers configured host-side). The provider chain + SSRF guard " +
    "run host-side — this extension owns no network/credential grants.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "search-web",
      description:
        "Search the web for a query. Returns a ranked markdown list of results with title, URL, and snippet.",
      // How a user would ASK for a web search — phrased as intent, not a
      // restatement of the description. The first entry is a live-measured
      // MiniLM miss (description cosine 0.19, below the gate).
      suggestExamples: [
        "search the web for the latest bun runtime release notes",
        "find recent articles about the topic we're discussing",
        "look up what people are saying about this online",
      ],
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Maximum number of results to return.",
          },
        },
      },
    },
    {
      name: "read-url",
      description:
        "Fetch a URL and return the main content as clean markdown, ready for summarization.",
      suggestExamples: [
        "read this page and summarize it for me",
        "pull the article at this link into markdown",
        "fetch the contents of this url so we can discuss it",
      ],
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri", description: "URL to fetch" },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 200000,
            default: 20000,
            description: "Maximum characters to return; content is truncated with an ellipsis.",
          },
        },
      },
    },
  ],
  permissions: {
    // The host `ctx.search` capability is now the ONLY grant this
    // extension needs. The provider chain (SearXNG / DuckDuckGo / BYOK),
    // the SSRF egress guard, and the shared cache all run HOST-SIDE
    // behind this capability — so the extension owns NO network hosts, NO
    // provider API-key env vars, and NO filesystem grant. `"inherit"`
    // tracks the instance search defaults (bundled = full grant via the
    // ceiling). See src/search/ for the implementation.
    search: "inherit",
  },
  resources: { memory: "128MB" },
});
