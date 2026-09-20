import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Holds `compose.podman-mac.yml` — the macOS/rootless-Podman override for the
 * PROD stack — against the two artifacts it silently depends on.
 *
 * ## The bug this exists to prevent
 *
 * compose.prod.yml binds four host paths under ./.ezcorp into a container
 * that runs as `USER bun` (uid 1000, Dockerfile). Under rootless Podman the
 * invoking user maps to container uid 0, NOT to 1000 — so 1000 lands in the
 * subuid range with no access to the virtiofs-shared host tree, and PGlite
 * cannot open its data dir on first boot. The override fixes that with
 * `userns_mode: keep-id:uid=1000,gid=1000`.
 *
 * That uid is a magic number in a YAML string, and it is the SAME number as
 * the one in the README's `chown -R 1000:1000` quick-start step and in the
 * image's `USER`. Change the image's runtime user and two of those three
 * update naturally (you edit the Dockerfile, you edit the README you are
 * reading) while this override does not — and the failure it then causes is
 * a first-boot permission error on a machine no CI runner has.
 *
 * ## Why this is not a tautology
 *
 * No assertion restates a literal read from the file it checks:
 *
 *   - the uid/gid in the override is compared to the uid in compose.prod.yml's
 *     own documented chown, so the two statements of "who the runtime is"
 *     cannot diverge;
 *   - the image is required to actually declare a non-root USER, because an
 *     image that went back to root would make the whole override unnecessary
 *     rather than merely wrong;
 *   - every service the override names must exist in the base file, catching
 *     an override left behind by a rename;
 *   - the override is required to carry NO sequence field. Compose APPENDS
 *     sequences across -f files rather than replacing them (the `!override`
 *     footgun documented at length in compose.podman.yml), so a `volumes:` or
 *     `tmpfs:` added here later would duplicate the base file's entries and
 *     fail the config at parse time, on the one platform this file targets.
 */

const ROOT = join(import.meta.dir, "..", "..");

const BASE = "compose.prod.yml";
const OVERRIDE = "compose.podman-mac.yml";

interface ComposeFile {
  services?: Record<string, Record<string, unknown>>;
}

async function parse(relPath: string): Promise<ComposeFile> {
  return Bun.YAML.parse(await Bun.file(join(ROOT, relPath)).text()) as ComposeFile;
}

/**
 * The uid from compose.prod.yml's own ownership instruction — it appears in
 * the header comment and again beside the ./.ezcorp/data bind, both as
 * `chown -R <uid>:<gid> .ezcorp/data`. Parsed from the raw text rather than
 * the parsed YAML because it lives in comments, which is precisely why it
 * drifts.
 */
async function documentedRuntimeUid(): Promise<{ uid: string; gid: string }> {
  const text = await Bun.file(join(ROOT, BASE)).text();
  const matches = [...text.matchAll(/chown -R (\d+):(\d+) \.ezcorp\/data/g)];
  expect(matches.length).toBeGreaterThan(0);
  const uids = new Set(matches.map((m) => `${m[1]}:${m[2]}`));
  // If the base file ever disagrees with itself, say so here rather than
  // letting whichever copy is read first win.
  expect([...uids]).toHaveLength(1);
  const [uid, gid] = [...uids][0]!.split(":");
  return { uid: uid!, gid: gid! };
}

describe("compose.podman-mac.yml", () => {
  test("maps the same uid/gid the base stack documents as the runtime owner", async () => {
    const { uid, gid } = await documentedRuntimeUid();
    const app = (await parse(OVERRIDE)).services?.app;
    expect(app).toBeDefined();

    const mode = app?.userns_mode;
    expect(typeof mode).toBe("string");
    expect(mode).toBe(`keep-id:uid=${uid},gid=${gid}`);
  });

  test("is only needed because the image declares a non-root USER", async () => {
    const dockerfile = await Bun.file(join(ROOT, "Dockerfile")).text();
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toBe("root");
    expect(users.at(-1)).not.toBe("0");
  });

  test("overrides only services the base stack actually defines", async () => {
    const base = await parse(BASE);
    const override = await parse(OVERRIDE);
    const baseNames = Object.keys(base.services ?? {});
    expect(baseNames.length).toBeGreaterThan(0);

    for (const name of Object.keys(override.services ?? {})) {
      expect(baseNames).toContain(name);
    }
  });

  test("declares no sequence field, which compose would append rather than replace", async () => {
    const override = await parse(OVERRIDE);
    const services = Object.entries(override.services ?? {});
    expect(services.length).toBeGreaterThan(0);

    for (const [name, service] of services) {
      for (const [key, value] of Object.entries(service)) {
        expect(`${name}.${key}=${Array.isArray(value) ? "sequence" : "scalar"}`).toBe(
          `${name}.${key}=scalar`,
        );
      }
    }
  });
});
