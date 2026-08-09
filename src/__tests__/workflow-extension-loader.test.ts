/**
 * Extension-shipped `*.workflow.yaml` discovery.
 *
 * The load-bearing assertion here is the SHADOWING one: the merged cache is
 * `[...extension, ...yaml, ...db]` with no de-duplication and `find(w =>
 * w.name === name)` lookup, so an extension workflow that could name itself
 * `demo-deterministic` would silently replace the host's. Every test below
 * that touches naming exists to prove that cannot happen.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadExtensionWorkflows,
  collectExtensionWorkflowSources,
  type ExtensionWorkflowSource,
} from "../runtime/workflow-extension-loader";
import {
  namespacedWorkflowName,
  isValidWorkflowName,
  EXTENSION_WORKFLOW_SEPARATOR,
} from "../runtime/workflow-name";
import type { ExtensionManifestV2 } from "../extensions/types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ez-ext-wf-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Create an install dir for `extensionName` and drop the given files in it. */
async function installExtension(
  extensionName: string,
  files: Record<string, string>,
): Promise<ExtensionWorkflowSource> {
  const installPath = join(root, extensionName);
  await mkdir(installPath, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(installPath, file), content);
  }
  return { extensionName, installPath };
}

const VALID_YAML = (name: string) =>
  `name: ${name}\ndescription: a shipped workflow\nsteps:\n  - name: emit\n    kind: transform\n    output:\n      hello: world\n`;

describe("loadExtensionWorkflows — discovery", () => {
  test("loads a *.workflow.yaml from the extension's own install path", async () => {
    const src = await installExtension("my-ext", {
      "deploy.workflow.yaml": VALID_YAML("deploy"),
    });

    const loaded = await loadExtensionWorkflows([src]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe("my-ext:deploy");
    expect(loaded[0]?.description).toBe("a shipped workflow");
    expect(loaded[0]?.steps).toHaveLength(1);
    // Provenance stamp read by `canRunWorkflow`.
    expect(loaded[0]?.source).toBe("extension");
  });

  test("a declared `source:` in the asset cannot forge provenance", async () => {
    // The stamp is applied AFTER the spread precisely so an extension
    // cannot label its own asset `db` (or anything else) and change which
    // authorization rule it is held to.
    const src = await installExtension("my-ext", {
      "deploy.workflow.yaml": `${VALID_YAML("deploy")}source: db\n`,
    });

    const loaded = await loadExtensionWorkflows([src]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.source).toBe("extension");
  });

  test("ignores files that are not *.workflow.yaml", async () => {
    const src = await installExtension("my-ext", {
      "ezcorp.config.ts": "export default {}",
      "notes.yaml": VALID_YAML("notes"),
      // The host loader also accepts the legacy `*.pipeline.yaml` glob; the
      // extension surface is NEW, so it has no legacy to honour.
      "legacy.pipeline.yaml": VALID_YAML("legacy"),
    });

    expect(await loadExtensionWorkflows([src])).toEqual([]);
  });

  test("loads from multiple extensions, each under its own namespace", async () => {
    const a = await installExtension("ext-a", { "run.workflow.yaml": VALID_YAML("run") });
    const b = await installExtension("ext-b", { "run.workflow.yaml": VALID_YAML("run") });

    const loaded = await loadExtensionWorkflows([a, b]);

    // Same DECLARED name in both — namespacing keeps them distinct, so
    // neither shadows the other in the merged cache.
    expect(loaded.map((w) => w.name)).toEqual(["ext-a:run", "ext-b:run"]);
  });

  test("defaults a missing description to the empty string", async () => {
    const src = await installExtension("my-ext", {
      "d.workflow.yaml":
        "name: d\nsteps:\n  - name: t\n    kind: transform\n    output:\n      a: b\n",
    });

    expect((await loadExtensionWorkflows([src]))[0]?.description).toBe("");
  });

  test("a missing / unreadable install dir warns and yields nothing (never throws)", async () => {
    const loaded = await loadExtensionWorkflows([
      { extensionName: "ghost", installPath: join(root, "does-not-exist") },
    ]);
    expect(loaded).toEqual([]);
  });

  test("an empty source list is a no-op", async () => {
    expect(await loadExtensionWorkflows([])).toEqual([]);
  });
});

describe("loadExtensionWorkflows — the shadowing guard", () => {
  test("an extension CANNOT ship a workflow that shadows a host workflow", async () => {
    // The exact attack: name the file's workflow after a host demo so
    // `find(w => w.name === "demo-deterministic")` returns the extension's.
    const src = await installExtension("evil-ext", {
      "x.workflow.yaml": VALID_YAML("demo-deterministic"),
    });

    const loaded = await loadExtensionWorkflows([src]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe("evil-ext:demo-deterministic");
    expect(loaded[0]?.name).not.toBe("demo-deterministic");
    // Host names never carry the separator, so a namespaced name can never
    // collide with one.
    expect(loaded[0]?.name).toContain(EXTENSION_WORKFLOW_SEPARATOR);
  });

  test("a declared name carrying the separator is REJECTED, not re-namespaced", async () => {
    // Without this rule `evil-ext` could declare `other-ext:deploy` and the
    // result (`evil-ext:other-ext:deploy`) would at best be ambiguous — and
    // any future prefix-strip would hand it another extension's namespace.
    const src = await installExtension("evil-ext", {
      "x.workflow.yaml": VALID_YAML("other-ext:deploy"),
    });

    expect(await loadExtensionWorkflows([src])).toEqual([]);
  });

  test("a declared name outside the grammar is rejected (path chars, spaces, empty)", async () => {
    const src = await installExtension("my-ext", {
      "a.workflow.yaml": VALID_YAML("../escape"),
      "b.workflow.yaml": VALID_YAML('"has space"'),
      "c.workflow.yaml":
        'name: ""\nsteps:\n  - name: t\n    kind: transform\n    output:\n      a: b\n',
      "d.workflow.yaml":
        "name: 42\nsteps:\n  - name: t\n    kind: transform\n    output:\n      a: b\n",
      "e.workflow.yaml": "steps:\n  - name: t\n    kind: transform\n    output:\n      a: b\n",
    });

    expect(await loadExtensionWorkflows([src])).toEqual([]);
  });

  test("a name longer than the 64-char grammar cap is rejected", async () => {
    const src = await installExtension("my-ext", {
      "long.workflow.yaml": VALID_YAML("a".repeat(65)),
    });

    expect(await loadExtensionWorkflows([src])).toEqual([]);
  });

  test("two files in ONE extension declaring the same name: first wins, second skipped", async () => {
    const src = await installExtension("my-ext", {
      "a-first.workflow.yaml": `name: dup\ndescription: first\nsteps:\n  - name: t\n    kind: transform\n    output:\n      a: b\n`,
      "z-second.workflow.yaml": `name: dup\ndescription: second\nsteps:\n  - name: t\n    kind: transform\n    output:\n      a: b\n`,
    });

    const loaded = await loadExtensionWorkflows([src]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.description).toBe("first");
  });
});

describe("loadExtensionWorkflows — validation (warn-and-skip, never throw)", () => {
  test("an unparseable YAML file is skipped and the rest still load", async () => {
    const src = await installExtension("my-ext", {
      "bad.workflow.yaml": "name: [unclosed\n  : : :",
      "good.workflow.yaml": VALID_YAML("good"),
    });

    const loaded = await loadExtensionWorkflows([src]);

    expect(loaded.map((w) => w.name)).toEqual(["my-ext:good"]);
  });

  test("a definition that fails the SHARED validateWorkflow is skipped", async () => {
    const src = await installExtension("my-ext", {
      // gate with no condition — rejected by the shared validator
      "bad.workflow.yaml": "name: bad\nsteps:\n  - name: g\n    kind: gate\n",
      "good.workflow.yaml": VALID_YAML("good"),
    });

    const loaded = await loadExtensionWorkflows([src]);

    expect(loaded.map((w) => w.name)).toEqual(["my-ext:good"]);
  });

  test("a zero-step definition is skipped", async () => {
    const src = await installExtension("my-ext", {
      "empty.workflow.yaml": "name: empty\nsteps: []\n",
    });

    expect(await loadExtensionWorkflows([src])).toEqual([]);
  });

  test("one broken extension never stops a later extension from loading", async () => {
    const broken = await installExtension("broken-ext", {
      "x.workflow.yaml": "name: x\nsteps:\n  - name: g\n    kind: gate\n",
    });
    const fine = await installExtension("fine-ext", {
      "y.workflow.yaml": VALID_YAML("y"),
    });

    expect((await loadExtensionWorkflows([broken, fine])).map((w) => w.name)).toEqual([
      "fine-ext:y",
    ]);
  });
});

describe("the shared workflow-name grammar", () => {
  test("namespacedWorkflowName joins with the single documented separator", () => {
    expect(namespacedWorkflowName("ext", "wf")).toBe("ext:wf");
    expect(EXTENSION_WORKFLOW_SEPARATOR).toBe(":");
  });

  test("isValidWorkflowName accepts bare names and rejects everything else", () => {
    expect(isValidWorkflowName("deploy")).toBe(true);
    expect(isValidWorkflowName("a")).toBe(true);
    expect(isValidWorkflowName("a.b-c_d9")).toBe(true);
    expect(isValidWorkflowName("a".repeat(64))).toBe(true);

    expect(isValidWorkflowName("a".repeat(65))).toBe(false);
    expect(isValidWorkflowName("ext:deploy")).toBe(false);
    expect(isValidWorkflowName("-leading-dash")).toBe(false);
    expect(isValidWorkflowName(".hidden")).toBe(false);
    expect(isValidWorkflowName("../escape")).toBe(false);
    expect(isValidWorkflowName("has space")).toBe(false);
    expect(isValidWorkflowName("")).toBe(false);
    expect(isValidWorkflowName(42)).toBe(false);
    expect(isValidWorkflowName(undefined)).toBe(false);
  });
});

describe("collectExtensionWorkflowSources", () => {
  function fakeRegistry(
    rows: Array<{ id: string; name: string | undefined; installPath: string | null }>,
  ) {
    return {
      getAllManifests: () =>
        rows
          .map(
            (r) =>
              [r.id, { name: r.name } as unknown as ExtensionManifestV2] as [
                string,
                ExtensionManifestV2,
              ],
          )
          [Symbol.iterator](),
      getInstallPath: (id: string) => rows.find((r) => r.id === id)?.installPath ?? null,
    };
  }

  test("maps every enabled extension with an install path to a source", () => {
    const sources = collectExtensionWorkflowSources(
      fakeRegistry([
        { id: "e1", name: "alpha", installPath: "/opt/alpha" },
        { id: "e2", name: "beta", installPath: "/opt/beta" },
      ]),
    );

    expect(sources).toEqual([
      { extensionName: "alpha", installPath: "/opt/alpha" },
      { extensionName: "beta", installPath: "/opt/beta" },
    ]);
  });

  test("skips rows with no install path (MCP-only / legacy rows have nothing to scan)", () => {
    const sources = collectExtensionWorkflowSources(
      fakeRegistry([
        { id: "e1", name: "alpha", installPath: null },
        { id: "e2", name: "beta", installPath: "/opt/beta" },
      ]),
    );

    expect(sources).toEqual([{ extensionName: "beta", installPath: "/opt/beta" }]);
  });

  test("skips rows with no usable manifest name (the namespace prefix)", () => {
    const sources = collectExtensionWorkflowSources(
      fakeRegistry([
        { id: "e1", name: undefined, installPath: "/opt/nameless" },
        { id: "e2", name: "", installPath: "/opt/empty" },
      ]),
    );

    expect(sources).toEqual([]);
  });
});
