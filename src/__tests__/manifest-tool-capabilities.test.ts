import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";

/** Validate a manifest whose only tool declares `capabilities`. */
function errorsFor(capabilities: unknown): string[] {
  return validateManifestV2({
    schemaVersion: 2,
    name: "caps-test",
    version: "1.0.0",
    description: "per-tool capabilities",
    author: { name: "t" },
    entrypoint: "index.ts",
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" }, capabilities }],
  }).errors;
}

const P = "tools[0].capabilities";

describe("validateManifestV2: per-tool capabilities", () => {
  test("accepts a full, well-formed block", () => {
    expect(errorsFor({
      network: { hosts: ["api.example.com"] },
      filesystem: { paths: ["/data"], mode: ["read", "write"] },
      shell: false,
      env: ["API_KEY"],
      storage: true,
      custom: { drafts: true, scopes: ["a", "b"] },
    })).toEqual([]);
  });

  test.each([
    ["null", null, `${P} must be an object`],
    ["an array", [], `${P} must be an object`],
    ["an unknown key", { gpu: true }, `${P}.gpu is not a recognized field`],
  ])("rejects %s as the block", (_label, caps, message) => {
    expect(errorsFor(caps)).toContain(message);
  });

  test.each([
    ["network without hosts", { network: {} }, `${P}.network must be { hosts: string[] }`],
    ["network as an array", { network: [] }, `${P}.network must be { hosts: string[] }`],
    ["a non-string host", { network: { hosts: ["ok", 1] } }, `${P}.network.hosts entries must be strings`],
    ["an extra network key", { network: { hosts: [], ports: [80] } }, `${P}.network.ports is not a recognized field`],
    ["filesystem without mode", { filesystem: { paths: [] } }, `${P}.filesystem must be { paths: string[], mode: ("read"|"write")[] }`],
    ["a non-string path", { filesystem: { paths: [7], mode: ["read"] } }, `${P}.filesystem.paths entries must be strings`],
    ["an unknown mode", { filesystem: { paths: [], mode: ["exec"] } }, `${P}.filesystem.mode entries must be "read" or "write"`],
    ["a non-boolean shell", { shell: "yes" }, `${P}.shell must be a boolean`],
    ["env as a string", { env: "API_KEY" }, `${P}.env must be a string array`],
    ["a non-string env entry", { env: [1] }, `${P}.env entries must be strings`],
    ["a non-boolean storage", { storage: 1 }, `${P}.storage must be a boolean`],
    ["custom as an array", { custom: [] }, `${P}.custom must be a plain object`],
    ["a numeric custom value", { custom: { n: 3 } }, `${P}.custom.n must be a boolean or string array`],
    ["a custom array with a non-string entry", { custom: { scopes: ["a", 2] } }, `${P}.custom.scopes must be a boolean or string array`],
  ])("rejects %s", (_label, caps, message) => {
    expect(errorsFor(caps)).toContain(message);
  });
});

describe("validateManifestV2: nested block keys", () => {
  test.each([
    ["panel", { position: "right", width: 3 }, "panel.width is not a recognized field"],
    ["resources", { memory: 128, cpu: 2 }, "resources.cpu is not a recognized field"],
  ])("rejects an unknown key in %s", (field, value, message) => {
    const { errors } = validateManifestV2({
      schemaVersion: 2, name: "keys-test", version: "1.0.0", description: "d",
      author: { name: "t" }, tools: [], [field]: value,
    });
    expect(errors).toContain(message);
  });
});
