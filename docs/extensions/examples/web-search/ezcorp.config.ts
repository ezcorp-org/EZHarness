import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "web-search",
  version: "1.0.0",
  description:
    "Web search and URL-to-markdown reader. Keyless by default (Jina AI); " +
    "set TAVILY_API_KEY, BRAVE_API_KEY, EXA_API_KEY, or SERPAPI_API_KEY to upgrade.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "search-web",
      description:
        "Search the web for a query. Returns a ranked markdown list of results with title, URL, and snippet.",
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
    network: [
      "r.jina.ai",
      "s.jina.ai",
      "api.tavily.com",
      "api.search.brave.com",
      "api.exa.ai",
      "serpapi.com",
    ],
    env: [
      "TAVILY_API_KEY",
      "BRAVE_API_KEY",
      "EXA_API_KEY",
      "SERPAPI_API_KEY",
      "JINA_API_KEY",
    ],
    // Disk-backed TTL/LRU cache lives under
    // `<projectRoot>/.ezcorp/extension-data/web-search/cache.json` —
    // see cache.ts. Without this grant the cache becomes a no-op
    // (helpful for tests, but rate-limited providers like Jina will
    // hit their per-hour ceiling fast in production).
    filesystem: ["$CWD"],
  },
  resources: { memory: "256MB" },
});
