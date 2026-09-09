/**
 * Extension-shipped workflow assets.
 *
 * An installed extension may ship `*.workflow.yaml` files at the root of
 * its install directory. They are loaded at boot and merged into the same
 * in-memory cache as the host's own YAML + DB workflows, so they appear in
 * `GET /api/workflows`, on `/workflows`, and are runnable through the same
 * `POST /api/workflows/[name]/run` route.
 *
 * Discovery reads the EXTENSION'S OWN install path
 * (`ExtensionRegistry.getInstallPath`) — deliberately NOT
 * `resolveAgentsDir()`, which is the HOST's directory. An extension has no
 * business writing into `src/agents/`, and globbing the host dir for
 * extension assets would be a trivial way to smuggle a host-named workflow
 * in.
 *
 * ── The load-bearing security property: namespacing ────────────────────
 *
 * The merged cache is `[...extension, ...yaml, ...db]` with NO
 * de-duplication, and every lookup is `find(w => w.name === name)`. So an
 * extension workflow that could NAME ITSELF `demo-deterministic` would
 * shadow the host's. Two rules make that impossible:
 *
 *   1. Every extension workflow is renamed to
 *      `<extensionName>:<declaredName>` before it enters the cache. The
 *      declared name is never used verbatim.
 *   2. A declared name containing the `:` separator is REJECTED (warn +
 *      skip), so an extension can neither forge another extension's
 *      namespace nor produce a name whose prefix is ambiguous.
 *
 * Extension names are validated at admit time against
 * `/^[a-z0-9][a-z0-9-_.]{0,63}$/` (no `:`), so a namespaced name always
 * contains exactly one separator and can never equal a bare host workflow
 * name — the host's demos, and any name the `/workflows/new` builder
 * produces, have no `:` at all.
 *
 * Shipping a workflow is NOT a permission — it is an asset, like a tool
 * declaration. TRIGGERING one from extension code is the privileged act,
 * and that is gated by `permissions.workflows` + the `ezcorp/workflows`
 * reverse-RPC handler.
 *
 * Every file is validated with the SAME shared `validateWorkflow` the host
 * loader and the API route use; an invalid file is skipped with a warning.
 * This function never throws — a broken asset in one extension must not
 * take down boot.
 */
import { parse } from "yaml";
import type { WorkflowDefinition } from "../types";
import type { ExtensionRegistry } from "../extensions/registry";
import { validateWorkflow } from "./workflow-validator";
import {
  WORKFLOW_NAME_RE,
  isValidWorkflowName,
  namespacedWorkflowName,
} from "./workflow-name";
import { logger } from "../logger";

const log = logger.child("workflow");

/** One extension's discovery coordinates. Kept as a plain value type so
 *  unit tests can drive the loader against a temp dir without a registry. */
export interface ExtensionWorkflowSource {
  /** The manifest name — becomes the namespace prefix. */
  extensionName: string;
  /** Absolute install directory to scan (non-recursively). */
  installPath: string;
}

/**
 * Collect the discovery coordinates for every enabled extension the
 * registry knows about. Extensions without a recorded install path (an
 * MCP-only row, or a pre-install-path legacy row) are skipped — there is
 * nothing to scan.
 */
export function collectExtensionWorkflowSources(
  registry: Pick<ExtensionRegistry, "getAllManifests" | "getInstallPath">,
): ExtensionWorkflowSource[] {
  const sources: ExtensionWorkflowSource[] = [];
  for (const [extensionId, manifest] of registry.getAllManifests()) {
    const installPath = registry.getInstallPath(extensionId);
    if (!installPath || typeof manifest?.name !== "string" || !manifest.name) continue;
    sources.push({ extensionName: manifest.name, installPath });
  }
  return sources;
}

/**
 * Load and namespace every `*.workflow.yaml` shipped by the given
 * extensions. Warn-and-continue on every failure class (unreadable dir,
 * unparseable YAML, bad declared name, failed validation, intra-extension
 * duplicate) — never throws.
 */
export async function loadExtensionWorkflows(
  sources: ExtensionWorkflowSource[],
): Promise<WorkflowDefinition[]> {
  const out: WorkflowDefinition[] = [];
  for (const source of sources) {
    await loadOne(source, out);
  }
  return out;
}

export function loadExtensionWorkflowFiles(extensionName: string, files: Record<string, string>): WorkflowDefinition[] {
  const output: WorkflowDefinition[] = [];
  const claimed = new Set<string>();
  for (const file of Object.keys(files).sort()) {
    if (file.includes("/") || !file.endsWith(".workflow.yaml")) continue;
    appendWorkflowAsset(extensionName, file, files[file]!, claimed, output);
  }
  return output;
}

async function loadOne(
  source: ExtensionWorkflowSource,
  out: WorkflowDefinition[],
): Promise<void> {
  const { extensionName, installPath } = source;
  // Names already taken by THIS extension. Cross-extension collision is
  // structurally impossible (different prefixes); two files inside one
  // extension declaring the same name is not, so first-wins + warn.
  const claimed = new Set<string>();
  const glob = new Bun.Glob("*.workflow.yaml");

  let files: string[];
  try {
    files = await Array.fromAsync(glob.scan({ cwd: installPath, absolute: true }));
  } catch (err) {
    // A missing / unreadable install dir is not fatal: the extension is
    // still installed and its tools still work, it just ships no workflows.
    log.warn("Failed to scan extension workflows", {
      extensionName,
      installPath,
      error: String(err),
    });
    return;
  }

  for (const file of files.sort()) {
    try {
      appendWorkflowAsset(extensionName, file, await Bun.file(file).text(), claimed, out);
    } catch (error) {
      log.warn("Failed to read extension workflow", { extensionName, file, error: String(error) });
    }
  }
}

function appendWorkflowAsset(extensionName: string, file: string, source: string, claimed: Set<string>, out: WorkflowDefinition[]): void {
    let def: WorkflowDefinition;
    try {
      def = parse(source) as WorkflowDefinition;
    } catch (err) {
      log.warn("Failed to load extension workflow", {
        extensionName,
        file,
        error: String(err),
      });
      return;
    }

    const declaredName = (def as { name?: unknown } | null)?.name;
    if (!isValidWorkflowName(declaredName)) {
      log.warn(
        `Skipping extension workflow with an invalid name — must match ${WORKFLOW_NAME_RE.source} and must not contain the namespace separator`,
        { extensionName, file, declaredName: String(declaredName) },
      );
      return;
    }

    const name = namespacedWorkflowName(extensionName, declaredName);
    if (claimed.has(name)) {
      log.warn("Skipping duplicate extension workflow name (first file wins)", {
        extensionName,
        file,
        name,
      });
      return;
    }

    // Validate the NAMESPACED definition — what actually enters the cache
    // — through the one shared validator, same contract as the host
    // loader: warn-and-skip, never throw.
    // `source` is stamped AFTER the spread so a `source:` key declared in
    // the asset YAML cannot forge a different provenance and dodge the
    // extension-enabled re-check in `canRunWorkflow`.
    const namespaced: WorkflowDefinition = {
      ...def,
      name,
      description: def.description ?? "",
      source: "extension",
    };
    const errors = validateWorkflow(namespaced);
    if (errors.length > 0) {
      log.warn("Skipping invalid extension workflow", {
        extensionName,
        file,
        errors,
      });
      return;
    }

    claimed.add(name);
    out.push(namespaced);
}
