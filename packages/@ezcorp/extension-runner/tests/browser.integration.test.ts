import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, filesDigest } from "../src";
import { source, provision } from "./helpers";

test("rootless browser build seals an offline bundle and rejects undeclared tools and native imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-browser-build-"));
  const runner = new PodmanRunner({ root, ...await provision() });
  const config = { schemaVersion: 1, entrypoint: "app/app.js", html: "app/index.html", styles: ["app/style.css"], tools: ["echo"] };
  const files = { ...source(), "ezcorp.browser.json": JSON.stringify(config), "app/app.js": "import {label} from './label.js'; document.body.dataset.label=label;", "app/label.js": "export const label='offline bundled';", "app/index.html": '<main>Canvas</main><script src="./old.js"></script><link rel="stylesheet" href="./style.css">', "app/style.css": "body{color:rgb(1,2,3)}" };
  try {
    const build = async (input: typeof files) => runner.build({ operationId: randomUUID(), files: input, sourceDigest: filesDigest(input), entrypoint: "extension.ts", limits: buildLimits });
    const result = await build(files);
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("succeeded");
    expect(result.evidence.tests).toContainEqual({ name: "browser-compile", passed: true });
    const artifacts = await runner.collectArtifacts(result.artifactDigest!);
    expect(artifacts[".runner/browser.html"]).toContain("offline bundled");
    expect(artifacts[".runner/browser.html"]).toContain("body{color:rgb(1,2,3)}");
    expect(artifacts[".runner/browser.html"]).not.toContain('src="./old.js"');
    expect(artifacts[".runner/browser.json"]).toBe(JSON.stringify(config, Object.keys(config).sort()));
    expect(artifacts["app/index.html"]).toBe(files["app/index.html"]);
    expect((await build({ ...files, "ezcorp.browser.json": JSON.stringify({ ...config, tools: ["undeclared"] }) })).diagnostics).toContainEqual(expect.objectContaining({ code: "browser_tool_undeclared" }));
    expect((await build({ ...files, "app/app.js": "import {readFileSync} from 'node:fs';document.body.textContent=readFileSync('/etc/passwd','utf8');" })).state).toBe("failed");
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
