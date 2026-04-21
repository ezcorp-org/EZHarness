/**
 * Dependency graph resolution for extensions.
 * Pure functions -- no DB or git access; all I/O via injected callbacks.
 */

import type { ExtensionManifestV2, DependencySpec } from "./types";
import { satisfiesRange } from "./manifest";

// ── Types ───────────────────────────────────────────────────────────

export interface ResolvedDep {
  name: string;
  /** Install directory name: `name` for primary, `name@version` for multi-version */
  installId: string;
  version: string;
  source: string;
  requiredRange: string;
  alreadyInstalled: boolean;
}

export interface DependencyTreeNode {
  name: string;
  version: string;
  status: "install" | "already-installed";
  children: DependencyTreeNode[];
}

export interface ResolutionResult {
  /** Dependencies in topological order (leaves first) */
  toInstall: ResolvedDep[];
  /** Tree for display */
  tree: DependencyTreeNode;
}

export interface ResolutionOptions {
  /** Check if an extension is already installed, return its version or null */
  getInstalled: (name: string) => Promise<{ version: string } | null>;
  /** Fetch the manifest for a dependency source string */
  fetchManifest: (source: string) => Promise<ExtensionManifestV2>;
}

// ── Cycle Detection ─────────────────────────────────────────────────

/**
 * Detect cycles in a directed graph using DFS.
 * Returns the cycle path (e.g. ["A", "B", "A"]) or null if acyclic.
 */
export function detectCycles(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string>();

  for (const node of graph.keys()) {
    if (visited.has(node)) continue;

    const stack: Array<{ node: string; childIdx: number }> = [
      { node, childIdx: 0 },
    ];
    inStack.add(node);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = graph.get(frame.node) ?? [];

      if (frame.childIdx >= children.length) {
        // Done with this node
        inStack.delete(frame.node);
        visited.add(frame.node);
        stack.pop();
        continue;
      }

      const child = children[frame.childIdx]!;
      frame.childIdx++;

      if (inStack.has(child)) {
        // Found cycle -- reconstruct path
        const path: string[] = [child];
        for (let i = stack.length - 1; i >= 0; i--) {
          path.push(stack[i]!.node);
          if (stack[i]!.node === child) break;
        }
        return path.reverse();
      }

      if (!visited.has(child)) {
        parent.set(child, frame.node);
        inStack.add(child);
        stack.push({ node: child, childIdx: 0 });
      }
    }
  }

  return null;
}

// ── Dependency Resolution ───────────────────────────────────────────

interface InternalNode {
  name: string;
  version: string;
  source: string;
  requiredRange: string;
  deps: Record<string, DependencySpec>;
  alreadyInstalled: boolean;
}

/**
 * Resolve the full dependency tree for a root manifest.
 * Returns dependencies in topological (leaves-first) install order.
 */
export async function resolveDependencies(
  rootManifest: ExtensionManifestV2,
  options: ResolutionOptions,
): Promise<ResolutionResult> {
  const deps = rootManifest.dependencies;
  if (!deps || Object.keys(deps).length === 0) {
    return {
      toInstall: [],
      tree: {
        name: rootManifest.name,
        version: rootManifest.version,
        status: "install",
        children: [],
      },
    };
  }

  // Collect all nodes by recursively fetching manifests
  const nodes = new Map<string, InternalNode>();
  const rangeRequests = new Map<string, string[]>(); // name -> ranges requested

  async function collectDeps(
    depRecord: Record<string, DependencySpec>,
  ): Promise<void> {
    for (const [name, spec] of Object.entries(depRecord)) {
      // Track all requested ranges
      if (!rangeRequests.has(name)) rangeRequests.set(name, []);
      rangeRequests.get(name)!.push(spec.version);

      if (nodes.has(name)) continue; // Already visited

      const manifest = await options.fetchManifest(spec.source);
      const installed = await options.getInstalled(name);

      const node: InternalNode = {
        name,
        version: manifest.version,
        source: spec.source,
        requiredRange: spec.version,
        deps: manifest.dependencies ?? {},
        alreadyInstalled:
          installed != null && satisfiesRange(installed.version, spec.version),
      };
      nodes.set(name, node);

      // Recurse into this dep's deps
      if (Object.keys(node.deps).length > 0) {
        await collectDeps(node.deps);
      }
    }
  }

  await collectDeps(deps);

  // Build adjacency graph for cycle detection
  const graph = new Map<string, string[]>();
  for (const [name, node] of nodes) {
    graph.set(name, Object.keys(node.deps));
  }

  const cycle = detectCycles(graph);
  if (cycle) {
    throw new Error(
      `Circular dependency detected: ${cycle.join(" -> ")}`,
    );
  }

  // Check for multi-version requirements (incompatible ranges)
  const resolved: ResolvedDep[] = [];
  const processedNames = new Set<string>();

  function addResolved(name: string): void {
    if (processedNames.has(name)) return;
    processedNames.add(name);

    const node = nodes.get(name)!;
    // Process deps first (topological: leaves first)
    for (const depName of Object.keys(node.deps)) {
      addResolved(depName);
    }

    const ranges = rangeRequests.get(name) ?? [node.requiredRange];
    const uniqueRanges = [...new Set(ranges)];

    // Check if fetched version satisfies all ranges
    const unsatisfied = uniqueRanges.filter(
      (r) => !satisfiesRange(node.version, r),
    );

    if (unsatisfied.length === 0) {
      // Single version satisfies all ranges
      resolved.push({
        name,
        installId: name,
        version: node.version,
        source: node.source,
        requiredRange: uniqueRanges.join(", "),
        alreadyInstalled: node.alreadyInstalled,
      });
    } else {
      // Multi-version: primary version for satisfied ranges, scoped for unsatisfied
      resolved.push({
        name,
        installId: name,
        version: node.version,
        source: node.source,
        requiredRange: uniqueRanges
          .filter((r) => satisfiesRange(node.version, r))
          .join(", ") || uniqueRanges[0]!,
        alreadyInstalled: node.alreadyInstalled,
      });

      for (const range of unsatisfied) {
        // The range itself indicates the needed version -- use range floor as version
        const rangeVersion = range.replace(/^\^/, "");
        resolved.push({
          name,
          installId: `${name}@${rangeVersion}`,
          version: rangeVersion,
          source: node.source,
          requiredRange: range,
          alreadyInstalled: false,
        });
      }
    }
  }

  // Process root's direct deps (which recurse into transitive deps)
  for (const name of Object.keys(deps)) {
    addResolved(name);
  }

  // Build display tree
  function buildTreeNode(
    name: string,
    depRecord: Record<string, DependencySpec>,
  ): DependencyTreeNode {
    const node = nodes.get(name);
    const installed = resolved.find((r) => r.name === name);
    return {
      name,
      version: node?.version ?? "unknown",
      status: installed?.alreadyInstalled ? "already-installed" : "install",
      children: Object.keys(depRecord)
        .map((depName) => {
          const depNode = nodes.get(depName);
          return buildTreeNode(depName, depNode?.deps ?? {});
        }),
    };
  }

  const tree: DependencyTreeNode = {
    name: rootManifest.name,
    version: rootManifest.version,
    status: "install",
    children: Object.entries(deps).map(([name]) => {
      const node = nodes.get(name)!;
      return buildTreeNode(name, node.deps);
    }),
  };

  return { toInstall: resolved, tree };
}

// ── Tree Formatting ─────────────────────────────────────────────────

/**
 * Render a dependency tree as an npm-style string with box-drawing chars.
 */
export function formatDepTree(
  node: DependencyTreeNode,
  prefix = "",
  isLast = true,
): string {
  const marker = node.status === "already-installed" ? " (installed)" : " (new)";
  const isRoot = prefix === "" && isLast;
  const line = isRoot
    ? `${node.name}@${node.version}${marker}`
    : `${prefix}${isLast ? "└── " : "├── "}${node.name}@${node.version}${marker}`;

  const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");

  const childLines = node.children.map((child, i) =>
    formatDepTree(child, childPrefix, i === node.children.length - 1),
  );

  return [line, ...childLines].join("\n");
}
