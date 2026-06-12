import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "web-search",
  version: "1.0.0",
  description:
    "Web search and URL-to-markdown reader. Keyless by default via the bundled " +
    "SearXNG sidecar (SEARXNG_BASE_URL) with DuckDuckGo fallback; set TAVILY_API_KEY, " +
    "BRAVE_API_KEY, EXA_API_KEY, or SERPAPI_API_KEY to upgrade.",
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
      "s.jina.ai", // keyed Jina search (JINA_API_KEY) still uses it
      "api.tavily.com",
      "api.search.brave.com",
      "api.exa.ai",
      "serpapi.com",
      // Keyless DuckDuckGo fallback. `duckduckgo.com` itself is needed
      // for the `//duckduckgo.com/l/?uddg=` redirect shape.
      "lite.duckduckgo.com",
      "html.duckduckgo.com",
      "duckduckgo.com",
      // SearXNG sidecar. Internal/RFC-1918 hosts route through the
      // `ezcorp/network.internal` PDP and MUST be declared explicitly.
      // A custom SEARXNG_BASE_URL hostname outside this set requires
      // editing this grant (documented in the README).
      "searxng",
      "localhost",
      "127.0.0.1",
    ],
    env: [
      "TAVILY_API_KEY",
      "BRAVE_API_KEY",
      "EXA_API_KEY",
      "SERPAPI_API_KEY",
      "JINA_API_KEY",
      // Not credential-shaped (no _API_KEY/TOKEN/SECRET suffix) — just
      // points the SearXNG provider at the sidecar / a BYO instance.
      "SEARXNG_BASE_URL",
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
