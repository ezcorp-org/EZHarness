/**
 * Pins the SearXNG sidecar configuration that zero-setup web search
 * depends on (see docs/deployment.md "Web search sidecar"):
 *
 *   - `deploy/searxng/settings.yml` must keep `search.formats` with BOTH
 *     "html" and "json": upstream ships the JSON API disabled, and
 *     without it every `format=json` request from the web-search
 *     extension gets a 403.
 *   - `server.limiter` must stay false — the bot-protection limiter
 *     would only ever rate-limit / challenge the app itself (the
 *     instance is internal-only).
 *   - Both compose stacks must mount `./deploy/searxng` read-only at
 *     /etc/searxng (otherwise the committed config never applies).
 *   - The prod searxng service must publish NO ports — it is reachable
 *     only over the compose bridge as http://searxng:8080.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

async function parseYamlFile(relPath: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(join(ROOT, relPath)).text();
  return Bun.YAML.parse(text) as Record<string, unknown>;
}

interface ComposeService {
  volumes?: string[];
  ports?: string[];
}

async function searxngService(relPath: string): Promise<ComposeService> {
  const compose = await parseYamlFile(relPath);
  const services = compose.services as Record<string, ComposeService> | undefined;
  const svc = services?.searxng;
  expect(svc).toBeDefined();
  return svc!;
}

describe("deploy/searxng/settings.yml", () => {
  test("search.formats includes html AND json (json is OFF upstream → 403 footgun)", async () => {
    const settings = await parseYamlFile("deploy/searxng/settings.yml");
    const search = settings.search as { formats?: string[] };
    expect(search.formats).toContain("html");
    expect(search.formats).toContain("json");
  });

  test("server.limiter is disabled (internal-only instance would only throttle the app)", async () => {
    const settings = await parseYamlFile("deploy/searxng/settings.yml");
    const server = settings.server as { limiter?: boolean };
    expect(server.limiter).toBe(false);
  });
});

describe("compose wiring for the searxng sidecar", () => {
  test("dev compose mounts ./deploy/searxng read-only at /etc/searxng", async () => {
    const svc = await searxngService("docker-compose.yml");
    expect(svc.volumes).toContain("./deploy/searxng:/etc/searxng:ro");
  });

  test("prod compose mounts ./deploy/searxng read-only at /etc/searxng", async () => {
    const svc = await searxngService("compose.prod.yml");
    expect(svc.volumes).toContain("./deploy/searxng:/etc/searxng:ro");
  });

  test("prod searxng publishes no ports (bridge-internal only)", async () => {
    const svc = await searxngService("compose.prod.yml");
    expect(svc.ports).toBeUndefined();
  });
});
