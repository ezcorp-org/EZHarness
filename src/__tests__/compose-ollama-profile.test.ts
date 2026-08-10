import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Keeps the dev stack's `up` from being taken down by a sidecar nothing
 * depends on.
 *
 * ## The bug this exists to prevent
 *
 * 11434 is the well-known Ollama port, so a dev box running Ollama natively
 * (Homebrew service, NixOS `services.ollama`, a bare `ollama serve`) already
 * holds it. The dev `ollama` service publishes `127.0.0.1:11434:11434`, and
 * a lost bind is not a degraded sidecar — Docker aborts the entire `up`:
 *
 *   Error response from daemon: failed to set up container networking:
 *   failed to bind host port 127.0.0.1:11434/tcp: address already in use
 *
 * postgres, app and searxng go down with it, over a service all three are
 * independent of. Worse, the failed attempt leaves a half-created `ollama`
 * container with no network attached, so the NEXT `up` fails somewhere
 * unrelated: `ollama-init` exits 1 on `lookup ollama on 127.0.0.11:53: no
 * such host`, which reads as a DNS bug and sends you looking in the wrong
 * place entirely.
 *
 * The fix is a compose profile: the sidecar is opt-in
 * (`docker compose --profile ollama up -d`) and the default `up` never
 * touches 11434. Opting out is free because the app is `network_mode: host`
 * and points at `http://localhost:11434` — the same address whether a
 * host-native daemon or the container answers on it.
 *
 * ## Why this is not a tautology
 *
 * Nothing here restates a value someone picked. Each assertion is a RULE
 * applied to both compose files, or one artifact held against another:
 *
 *   - "publishes 11434 ⇒ must be gated" is evaluated against whatever the
 *     files actually publish. Prod passes it by publishing no host port at
 *     all (bridge + service DNS), so prod stays zero-setup without being
 *     special-cased here — and the day someone publishes a host port in
 *     prod, the same rule demands a profile;
 *   - the server's and puller's profile sets are compared to EACH OTHER,
 *     so gating one alone fails here rather than at `up` time;
 *   - the depends_on check derives the gated set from the file, so a future
 *     `depends_on: ollama` added to an ungated service is caught before it
 *     makes `docker compose config` a hard error;
 *   - the URL default is held against the app's network mode, which is what
 *     makes the opted-out path work.
 */

const ROOT = join(import.meta.dir, "..", "..");

interface Service {
  profiles?: string[];
  ports?: string[];
  depends_on?: string[] | Record<string, unknown>;
  environment?: string[] | Record<string, string>;
  network_mode?: string;
}

interface ComposeFile {
  services?: Record<string, Service>;
}

async function parse(relPath: string): Promise<ComposeFile> {
  return Bun.YAML.parse(await Bun.file(join(ROOT, relPath)).text()) as ComposeFile;
}

const DEV = "docker-compose.yml";
const PROD = "compose.prod.yml";

function servicesOf(compose: ComposeFile): Record<string, Service> {
  const services = compose.services;
  expect(services).toBeDefined();
  return services!;
}

/**
 * The host port a compose `ports:` entry binds, or null for a container-only
 * entry. Accepts the three published forms — `host:target`,
 * `ip:host:target`, and a bare `target` (which publishes on an ephemeral
 * host port, so it can never collide) — with an optional `/proto` suffix.
 */
function hostPortOf(entry: string): number | null {
  const parts = entry.split("/")[0]!.split(":");
  if (parts.length < 2) return null;
  const host = parts[parts.length - 2]!;
  const port = Number.parseInt(host, 10);
  return Number.isNaN(port) ? null : port;
}

function hostPortsOf(service: Service): number[] {
  return (service.ports ?? []).map(hostPortOf).filter((port): port is number => port !== null);
}

function profilesOf(service: Service): string[] {
  return service.profiles ?? [];
}

/** `depends_on` is either a list of names or a map keyed by name. */
function dependencyNamesOf(service: Service): string[] {
  const dependsOn = service.depends_on;
  if (!dependsOn) return [];
  return Array.isArray(dependsOn) ? dependsOn : Object.keys(dependsOn);
}

/** compose `environment:` is either `KEY=value` entries or a map. */
function environmentOf(service: Service): Map<string, string> {
  const environment = service.environment ?? {};
  if (!Array.isArray(environment)) return new Map(Object.entries(environment));
  const out = new Map<string, string>();
  for (const entry of environment) {
    const idx = entry.indexOf("=");
    if (idx !== -1) out.set(entry.slice(0, idx), entry.slice(idx + 1));
  }
  return out;
}

describe("a sidecar that can lose its port bind is never in the default `up`", () => {
  test("any service publishing the well-known Ollama port is profile-gated", async () => {
    // The rule, applied to both stacks rather than asserted about one
    // service. A lost bind on this port aborts the whole `up`, so anything
    // claiming it has to be something the user asked for.
    for (const file of [DEV, PROD]) {
      for (const [name, service] of Object.entries(servicesOf(await parse(file)))) {
        if (!hostPortsOf(service).includes(11434)) continue;
        expect(
          profilesOf(service).length,
          `${file}: '${name}' publishes host port 11434 but starts by default — ` +
            `a host-native Ollama would abort the whole stack's up`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("prod earns its ungated sidecar by publishing no host port", async () => {
    // Prod reaches ollama as http://ollama:11434 over the compose bridge, so
    // there is no host address to collide with and no reason to make a
    // self-hosted deploy pass an extra flag. This asserts the PREMISE of
    // that exemption, so it cannot quietly stop being true.
    const prod = servicesOf(await parse(PROD));
    for (const name of ["ollama", "ollama-init"]) {
      const service = prod[name];
      expect(service, `${PROD}: service '${name}' is missing`).toBeDefined();
      expect(hostPortsOf(service!), `${PROD}: '${name}' publishes a host port`).toEqual([]);
      expect(profilesOf(service!)).toEqual([]);
    }
  });

  test("the dev core is never gated — `docker compose up` still boots the app", async () => {
    // The flip side: gating is for optional sidecars only. If the profile
    // ever spread to these, a bare `up` would come up with no app at all.
    const dev = servicesOf(await parse(DEV));
    for (const name of ["postgres", "app", "searxng"]) {
      const service = dev[name];
      expect(service, `${DEV}: service '${name}' is missing`).toBeDefined();
      expect(profilesOf(service!), `${DEV}: core service '${name}' is profile-gated`).toEqual([]);
    }
  });
});

describe("the puller is gated with the server it pulls into", () => {
  test("both dev ollama services carry the same profiles", async () => {
    const dev = servicesOf(await parse(DEV));
    const server = dev.ollama;
    const init = dev["ollama-init"];
    expect(server, `${DEV}: service 'ollama' is missing`).toBeDefined();
    expect(init, `${DEV}: service 'ollama-init' is missing`).toBeDefined();

    // Compared to each other, not to a literal. Gating the server alone
    // leaves ollama-init in the default `up`, where it resolves the server
    // by compose DNS, finds no such name, and exits 1 — the exact failure
    // observed on a box with a host-native Ollama.
    expect(profilesOf(init!).sort()).toEqual(profilesOf(server!).sort());
    expect(profilesOf(server!).length).toBeGreaterThan(0);
  });

  test("no ungated service depends_on a gated one", async () => {
    // `docker compose config` is a hard error when an active service
    // depends on one excluded by profiles, so this would break the default
    // `up` outright. The gated set is derived from the file, not listed.
    for (const file of [DEV, PROD]) {
      const services = servicesOf(await parse(file));
      const gated = new Set(
        Object.entries(services)
          .filter(([, service]) => profilesOf(service).length > 0)
          .map(([name]) => name),
      );
      for (const [name, service] of Object.entries(services)) {
        if (gated.has(name)) continue;
        for (const dependency of dependencyNamesOf(service)) {
          expect(
            gated.has(dependency),
            `${file}: ungated '${name}' depends_on gated '${dependency}'`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("opting out costs nothing — the app's default URL still resolves", () => {
  test("dev points at loopback, which host-native Ollama and the container share", async () => {
    const app = servicesOf(await parse(DEV)).app;
    expect(app).toBeDefined();

    // The two halves are what make the sidecar optional, and they only work
    // together: on host networking, `localhost:11434` is answered by a
    // host-native daemon or by the opted-in container, indifferently. Copy
    // prod's `http://ollama:11434` here and the DEFAULT stack would point at
    // a DNS name that does not exist.
    expect(app!.network_mode).toBe("host");
    const url = environmentOf(app!).get("EZCORP_SUGGEST_OLLAMA_URL");
    expect(url, `${DEV}: app has no EZCORP_SUGGEST_OLLAMA_URL`).toBeDefined();
    expect(url).toContain("localhost:11434");
  });
});
