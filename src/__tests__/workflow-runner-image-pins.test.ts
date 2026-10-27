/**
 * Every GitHub-hosted Ubuntu job names its runner image version, never `ubuntu-latest`.
 *
 * When GitHub moved `ubuntu-latest` from ubuntu-24.04 to ubuntu-26.04, main went red with no commit of ours: 26.04's
 * Docker uses the containerd image store, where `docker image inspect .Id` is the manifest-list digest, not the config
 * digest that podman reports for the same loaded archive. The production image artifact's ID check then failed in
 * every "Production proof" job. A floating label lets the platform change the toolchain under a green commit; a
 * pinned label makes that change a reviewed edit.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const WORKFLOWS = join(root, ".github", "workflows");

/** Each `ubuntu-latest` in a workflow source, as `file:line`. */
function floatingUbuntu(file: string, source: string): string[] {
  return source.split("\n").flatMap((line, index) => (/\bubuntu-latest\b/.test(line) ? [`${file}:${index + 1}`] : []));
}

describe("workflow runner images", () => {
  test("floatingUbuntu finds the label in runs-on and in a matrix, and ignores a pinned one", () => {
    const source = ["jobs:", "  a:", "    runs-on: ubuntu-latest", "  b:", "    runs-on: ubuntu-24.04", "    strategy:", "      matrix:", "        os: [ubuntu-latest]"].join("\n");
    expect(floatingUbuntu("x.yml", source)).toEqual(["x.yml:3", "x.yml:8"]);
  });

  test("no workflow runs on ubuntu-latest", async () => {
    const files = (await Array.fromAsync(new Bun.Glob("*.{yml,yaml}").scan(WORKFLOWS))).sort();
    expect(files.length).toBeGreaterThan(5);
    const floating: string[] = [];
    for (const file of files) floating.push(...floatingUbuntu(file, await Bun.file(join(WORKFLOWS, file)).text()));
    expect(floating).toEqual([]);
  });
});
