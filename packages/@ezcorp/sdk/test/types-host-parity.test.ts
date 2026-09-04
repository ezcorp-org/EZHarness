/**
 * Structural drift guard between `@ezcorp/sdk/src/types.ts` (this package,
 * the public authoring surface) and `src/extensions/types.ts` (the host's
 * copy of the same manifest/tool/permission shapes).
 *
 * The two files are declared duplicates — see the header comment on
 * `../src/types.ts` — pending the plan-line-192 host-shim flip that will
 * replace the host file with `export * from "@ezcorp/sdk"`. Until that
 * lands, `defineExtension<T extends ExtensionConfig>(config: T): T` means
 * TypeScript's excess-property check never fires on an author's
 * `ezcorp.config.ts`, so a field the SDK type is MISSING (relative to what
 * the host actually reads) compiles clean and silently no-ops at runtime —
 * exactly the failure mode this test exists to catch before it ships again.
 *
 * Approach: parse both files as TEXT (comment-stripped, brace-depth-aware)
 * rather than importing a third canonical copy — `defineExtension`'s own
 * generic already proves TypeScript won't catch a drifted field for us, so
 * only a runtime scan of the actual declarations closes the gap. See the
 * `web/src/lib/runtime-event-names.ts` / `packages/@ezcorp/harness-client`
 * pair for the same pattern applied to a plain array constant; interfaces
 * need the extractor below because there's no runtime array to import.
 *
 * NOT everything the host declares is author-facing, so this file is NOT
 * a blanket "every field must match" assertion. Three categories are
 * treated differently:
 *
 *   1. Interfaces/blocks an extension author WRITES in `ezcorp.config.ts`
 *      — asserted EXACTLY equal (field-name sets).
 *   2. `McpServerStdio` and the manifest's `permissions` block each carry
 *      a SMALL, EXPLICIT allowlist of host-only bookkeeping fields (sandbox
 *      wiring populated by `mcp-sandbox.ts`; the bundled-only `custom`
 *      capability bag) — asserted equal AFTER removing exactly those names,
 *      so an undocumented new host-only field still fails the test and
 *      forces a deliberate choice (mirror it, or extend the allowlist with
 *      a reason).
 *   3. `ExtensionPermissions` (the GRANTED/installed representation, distinct
 *      from the manifest's `permissions` block) is host-computed bookkeeping
 *      never round-tripped through the SDK — asserted as a SUBSET (every
 *      field the SDK declares must exist on the host side), not full parity.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SDK_TYPES = join(REPO_ROOT, "packages/@ezcorp/extension-contract/src/legacy.ts");
const HOST_TYPES = join(REPO_ROOT, "src/extensions/types.ts");

const sdkSrc = readFileSync(SDK_TYPES, "utf8");
const hostSrc = readFileSync(HOST_TYPES, "utf8");

/** Strip block and line comments so brace-depth scanning never mistakes
 *  prose (e.g. a doc-commented URL containing "://") for code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const sdkClean = stripComments(sdkSrc);
const hostClean = stripComments(hostSrc);

/**
 * Find `marker` (e.g. `"export interface ToolDefinition {"` or
 * `"permissions: {"`) in `clean` and return the TEXT of its body, i.e.
 * everything between the matching `{` ... `}` pair (brace-depth matched,
 * so nested object types don't close it early).
 */
function extractBody(clean: string, marker: string, label: string): string {
  const markerIdx = clean.indexOf(marker);
  expect(markerIdx, `marker not found: ${label} (${marker})`).toBeGreaterThan(-1);
  const braceStart = clean.indexOf("{", markerIdx);
  let depth = 0;
  for (let i = braceStart; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return clean.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unbalanced braces extracting ${label}`);
}

/**
 * Given an object/interface BODY (as returned by `extractBody`), return
 * the field names declared directly on it (depth 0 relative to the body)
 * — nested object-typed members (e.g. `panel?: { position: ... }`) don't
 * leak their inner keys into the result.
 */
function topLevelFields(body: string): string[] {
  const fields: string[] = [];
  const memberRe = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/;
  let depth = 0;
  let pos = 0;
  while (pos < body.length) {
    const ch = body[pos];
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      pos++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      pos++;
      continue;
    }
    if (depth === 0) {
      const m = memberRe.exec(body.slice(pos));
      if (m) {
        fields.push(m[1] as string);
        pos += m[0].length;
        continue;
      }
    }
    pos++;
  }
  return fields;
}

function interfaceFields(clean: string, name: string): string[] {
  return topLevelFields(extractBody(clean, `export interface ${name} {`, name));
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Interfaces / nested blocks an extension author writes directly and
 *  that must therefore declare IDENTICAL field sets on both sides. */
describe("SDK/host manifest type parity — exact field sets", () => {
  const EXACT_MATCH_INTERFACES = [
    "ToolDefinition",
    "CapabilityDeclaration",
    "SkillDefinition",
    "PreprocessorDecl",
    "McpServerHttp",
    "McpServerSse",
    "AgentComponentDefinition",
    "ScriptDefinition",
    "DependencySpec",
    "SettingsFieldSelect",
    "SettingsFieldText",
    "SettingsFieldNumber",
    "SettingsFieldBoolean",
    "SettingsFieldSecret",
    "MessageToolbarItem",
    "ExtensionPageDeclaration",
    "JsonRpcRequest",
    "JsonRpcResponse",
    "ToolCallResult",
  ];

  for (const name of EXACT_MATCH_INTERFACES) {
    test(`${name} — same fields on both sides`, () => {
      expect(sorted(interfaceFields(sdkClean, name))).toEqual(sorted(interfaceFields(hostClean, name)));
    });
  }

  test("ExtensionManifestV2 — same top-level fields on both sides", () => {
    const sdkFields = topLevelFields(extractBody(sdkClean, "export interface ExtensionManifestV2 {", "SDK ExtensionManifestV2"));
    const hostFields = topLevelFields(extractBody(hostClean, "export interface ExtensionManifestV2 {", "host ExtensionManifestV2"));
    expect(sorted(sdkFields)).toEqual(sorted(hostFields));
  });

  // A few representative nested inline blocks on ExtensionManifestV2 that
  // an author writes directly (as opposed to `permissions`, which gets
  // its own test below because it carries a documented host-only field).
  for (const marker of ["author: {", "panel?: {", "resources?: {", "smokeTest?: {"]) {
    test(`ExtensionManifestV2["${marker.replace(/[?:{]/g, "").trim()}"] — same nested fields`, () => {
      const sdkManifestBody = extractBody(sdkClean, "export interface ExtensionManifestV2 {", "SDK ExtensionManifestV2");
      const hostManifestBody = extractBody(hostClean, "export interface ExtensionManifestV2 {", "host ExtensionManifestV2");
      const sdkFields = topLevelFields(extractBody(sdkManifestBody, marker, `SDK ${marker}`));
      const hostFields = topLevelFields(extractBody(hostManifestBody, marker, `host ${marker}`));
      expect(sorted(sdkFields)).toEqual(sorted(hostFields));
    });
  }

  // Small union/Record type aliases — compared as normalized whole-text,
  // since "field set" doesn't apply to a union of string literals.
  function typeAliasText(clean: string, name: string): string {
    const marker = `export type ${name} =`;
    const idx = clean.indexOf(marker);
    expect(idx, `type alias not found: ${name}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = idx + marker.length; i < clean.length; i++) {
      const ch = clean[i];
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      else if (ch === ";" && depth === 0) {
        return clean.slice(idx + marker.length, i).replace(/\s+/g, " ").trim();
      }
    }
    throw new Error(`unterminated type alias: ${name}`);
  }

  for (const name of ["McpTransport", "McpServerDefinition", "SettingsField", "SettingsSchema"]) {
    test(`${name} — identical alias text on both sides`, () => {
      expect(typeAliasText(sdkClean, name)).toEqual(typeAliasText(hostClean, name));
    });
  }
});

describe("SDK/host manifest type parity — permissions block (with documented host-only exceptions)", () => {
  // `custom` is the bundled-only capability bag (BUNDLED_DRAFTS_ALLOWLIST
  // gates it independent of what a manifest declares) — inert for a
  // third-party author, so it's deliberately NOT mirrored into the SDK
  // type. Any OTHER host-only field must be added here explicitly (or
  // mirrored into the SDK) for this test to pass — that's the guard.
  //
  // `mcpInvoke` is the `kind:"mcp"` dispatch sentinel. The host type says it
  // outright: "Synthesized (never author-written) by
  // `mcp-capabilities.ts:mcpManifestPermissions` for every MCP row". MCP
  // manifests are BUILT by the host from an admin's server definition — there
  // is no `ezcorp.config.ts` behind one — so mirroring this into the SDK would
  // advertise to third-party authors a permission they can never meaningfully
  // declare, on a manifest shape they never write. Host-only, like `custom`.
  const HOST_ONLY_PERMISSIONS_FIELDS = new Set(["custom", "mcpInvoke"]);

  test("author-declarable permission keys match (host minus the documented bundled-only allowlist)", () => {
    const sdkManifestBody = extractBody(sdkClean, "export interface ExtensionManifestV2 {", "SDK ExtensionManifestV2");
    const hostManifestBody = extractBody(hostClean, "export interface ExtensionManifestV2 {", "host ExtensionManifestV2");
    const sdkPerms = topLevelFields(extractBody(sdkManifestBody, "permissions: {", "SDK permissions"));
    const hostPerms = topLevelFields(extractBody(hostManifestBody, "permissions: {", "host permissions")).filter(
      (f) => !HOST_ONLY_PERMISSIONS_FIELDS.has(f),
    );
    expect(sorted(sdkPerms)).toEqual(sorted(hostPerms));
  });
});

describe("SDK/host manifest type parity — McpServerStdio (with documented host-only exceptions)", () => {
  // Sandbox wiring populated by `mcp-sandbox.ts:buildSandboxedMcpSpec()`
  // AFTER the manifest is loaded — never author-typed in `ezcorp.config.ts`.
  // `_internal_` is explicitly a do-not-consume-from-outside marker.
  const HOST_ONLY_STDIO_FIELDS = new Set(["seccompFd", "onChildSpawned", "_internal_vethSetup"]);

  test("author-declarable McpServerStdio fields match (host minus the documented sandbox-wiring allowlist)", () => {
    const sdkFields = interfaceFields(sdkClean, "McpServerStdio");
    const hostFields = interfaceFields(hostClean, "McpServerStdio").filter((f) => !HOST_ONLY_STDIO_FIELDS.has(f));
    expect(sorted(sdkFields)).toEqual(sorted(hostFields));
  });
});

describe("SDK/host manifest type parity — ExtensionPermissions (granted/installed representation)", () => {
  // This is the POST-INSTALL, host-computed grant record — not something
  // an author writes, and not consumed anywhere in the SDK's own runtime
  // (only re-exported). It is deliberately much narrower than the host's
  // copy and NOT expected to reach full parity. The one guard worth
  // keeping: the SDK must never declare a field name that doesn't exist
  // on the host's granted-permissions shape at all (a typo'd or
  // since-renamed key).
  test("every SDK ExtensionPermissions field exists on the host's ExtensionPermissions", () => {
    const sdkFields = interfaceFields(sdkClean, "ExtensionPermissions");
    const hostFields = new Set(interfaceFields(hostClean, "ExtensionPermissions"));
    const missing = sdkFields.filter((f) => !hostFields.has(f));
    expect(missing, `SDK ExtensionPermissions has field(s) absent from the host: ${missing.join(", ")}`).toEqual([]);
  });
});
