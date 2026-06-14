import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import { loadManifest } from "../extensions/loader";
import { join } from "path";

const EXAMPLES_DIR = join(import.meta.dir, "../../docs/extensions/examples");

const EXAMPLES = [
  "github-stats",
  "project-analyzer",
  "markdown-utils",
  "research-agent",
  "code-review-delegator",
  "multi-agent-orchestrator",
  "web-search",
  "weather",
  "ez-code",
] as const;

async function readManifest(name: string) {
  return loadManifest(join(EXAMPLES_DIR, name));
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

// ── Manifest validation ─────────────────────────────────────────

describe("example manifests pass validation", () => {
  for (const name of EXAMPLES) {
    test(`${name}/ezcorp.config.ts is valid`, async () => {
      const manifest = await readManifest(name);
      const result = validateManifestV2(manifest);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }
});

// ── Required files exist ────────────────────────────────────────

describe("example directories contain expected files", () => {
  for (const name of EXAMPLES) {
    test(`${name} has ezcorp.config.ts`, async () => {
      expect(await fileExists(join(EXAMPLES_DIR, name, "ezcorp.config.ts"))).toBe(true);
    });

    test(`${name} has README.md`, async () => {
      expect(await fileExists(join(EXAMPLES_DIR, name, "README.md"))).toBe(true);
    });
  }

  for (const name of ["github-stats", "project-analyzer", "markdown-utils", "code-review-delegator", "web-search", "weather", "ez-code"] as const) {
    test(`${name} has index.ts`, async () => {
      expect(await fileExists(join(EXAMPLES_DIR, name, "index.ts"))).toBe(true);
    });
  }
});

// ── Component-specific assertions ───────────────────────────────

describe("github-stats", () => {
  test("has tools and entrypoint", async () => {
    const m = await readManifest("github-stats");
    expect(m.entrypoint).toBeDefined();
    expect(m.tools).toBeArray();
    expect(m.tools!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("project-analyzer", () => {
  test("has tools and entrypoint", async () => {
    const m = await readManifest("project-analyzer");
    expect(m.entrypoint).toBeDefined();
    expect(m.tools).toBeArray();
    expect(m.tools!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("markdown-utils", () => {
  test("has tools, skills, and agent", async () => {
    const m = await readManifest("markdown-utils");
    expect(m.tools).toBeArray();
    expect(m.skills).toBeArray();
    expect(m.agent).toBeDefined();
    expect(m.entrypoint).toBeDefined();
  });
});

describe("research-agent", () => {
  test("has agent and no entrypoint", async () => {
    const m = await readManifest("research-agent");
    expect(m.agent).toBeDefined();
    expect(m.entrypoint).toBeUndefined();
  });
});

describe("code-review-delegator", () => {
  test("has tools, agent, entrypoint, and dependencies", async () => {
    const m = await readManifest("code-review-delegator");
    expect(m.tools).toBeArray();
    expect(m.agent).toBeDefined();
    expect(m.entrypoint).toBeDefined();
    expect(m.dependencies!["project-analyzer"]).toBeDefined();
    expect(m.dependencies!["code-quality"]).toBeDefined();
  });
});

describe("weather", () => {
  test("has entrypoint, one tool, cardType, and Open-Meteo hosts", async () => {
    const m = await readManifest("weather");
    expect(m.entrypoint).toBeDefined();
    expect(m.tools).toBeArray();
    expect(m.tools).toHaveLength(1);
    expect(m.tools?.[0]?.cardType).toBe("weather-panel");
    const hosts = m.permissions.network ?? [];
    expect(hosts).toContain("geocoding-api.open-meteo.com");
    expect(hosts).toContain("api.open-meteo.com");
  });
});

describe("multi-agent-orchestrator", () => {
  test("has agent, subAgents, and no entrypoint", async () => {
    const m = await readManifest("multi-agent-orchestrator");
    expect(m.agent).toBeDefined();
    expect((m as any).subAgents).toBeDefined();
    expect(m.entrypoint).toBeUndefined();
  });
});

describe("web-search", () => {
  test("has both tools, an entrypoint, and pre-declares every provider host/key", async () => {
    const m = await readManifest("web-search");
    expect(m.entrypoint).toBeDefined();
    const toolNames = (m.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual(["read-url", "search-web"]);
    const hosts = m.permissions.network ?? [];
    for (const h of [
      "r.jina.ai",
      "s.jina.ai",
      "api.tavily.com",
      "api.search.brave.com",
      "api.exa.ai",
      "serpapi.com",
      // Keyless defaults (DDG scrape + SearXNG sidecar) — removing any
      // of these grants silently breaks zero-setup search, so pin them.
      "lite.duckduckgo.com",
      "html.duckduckgo.com",
      "duckduckgo.com",
      "searxng",
      "localhost",
      "127.0.0.1",
    ]) expect(hosts).toContain(h);
    const envs = m.permissions.env ?? [];
    for (const k of [
      "TAVILY_API_KEY",
      "BRAVE_API_KEY",
      "EXA_API_KEY",
      "SERPAPI_API_KEY",
      "JINA_API_KEY",
      "SEARXNG_BASE_URL",
    ]) {
      expect(envs).toContain(k);
    }
  });
});
