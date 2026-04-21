/**
 * Extension permission checking, runtime confirmation, and always-allow persistence.
 */

import type { ExtensionPermissions, ExtensionManifest } from "./types";
import { getSetting, upsertSetting } from "../db/queries/settings";
import { realpath } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

// ── Permission Check ────────────────────────────────────────────────

export function checkPermission(
  type: "network" | "filesystem" | "shell" | "env" | "storage",
  value: string | boolean,
  granted: ExtensionPermissions,
): boolean {
  switch (type) {
    case "network":
      return granted.network?.includes(value as string) ?? false;

    case "filesystem": {
      const path = value as string;
      return granted.filesystem?.some((prefix) => path === prefix || path.startsWith(prefix + "/")) ?? false;
    }

    case "shell":
      return granted.shell === true;

    case "env":
      return granted.env?.includes(value as string) ?? false;

    case "storage":
      return granted.storage === true;

    default:
      return false;
  }
}

// ── Secure Filesystem Permission Check (realpath-resolved) ─────────

export interface FilesystemPermissionResult {
  allowed: boolean;
  resolvedPath: string;
}

/**
 * Check filesystem access using realpath resolution to prevent traversal and symlink escapes.
 * Resolves both the requested path and granted prefixes via realpath before comparing.
 * Implicitly allows access to the extension's own install directory.
 */
export async function checkFilesystemPermission(
  requestedPath: string,
  granted: ExtensionPermissions,
  extensionInstallDir: string,
): Promise<FilesystemPermissionResult> {
  // Resolve requested path via realpath
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(requestedPath);
  } catch {
    // Path doesn't exist -- deny
    return { allowed: false, resolvedPath: requestedPath };
  }

  // Resolve install dir via realpath
  let resolvedInstallDir: string;
  try {
    resolvedInstallDir = await realpath(extensionInstallDir);
  } catch {
    resolvedInstallDir = extensionInstallDir;
  }

  // Implicit access: extension's own install directory
  if (resolvedPath === resolvedInstallDir || resolvedPath.startsWith(resolvedInstallDir + "/")) {
    return { allowed: true, resolvedPath };
  }

  // Check granted filesystem prefixes
  const prefixes = granted.filesystem ?? [];
  for (const prefix of prefixes) {
    let resolvedPrefix: string;
    try {
      // Relative paths resolve against installDir
      const absolutePrefix = prefix.startsWith("/")
        ? prefix
        : pathResolve(extensionInstallDir, prefix);
      resolvedPrefix = await realpath(absolutePrefix);
    } catch {
      continue; // Skip unresolvable prefixes
    }

    if (resolvedPath === resolvedPrefix || resolvedPath.startsWith(resolvedPrefix + "/")) {
      return { allowed: true, resolvedPath };
    }
  }

  return { allowed: false, resolvedPath };
}

// ── Permission Display ──────────────────────────────────────────────

export interface PermissionItem {
  type: string;
  value: string | boolean;
  description: string;
}

const PERMISSION_DESCRIPTIONS: Record<string, (v: string | boolean) => string> = {
  network: (v) => `Network access to ${v}`,
  filesystem: (v) => `Filesystem access to ${v}`,
  shell: () => "Execute shell commands",
  env: (v) => `Read environment variable ${v}`,
  storage: () => "Persistent key-value storage",
};

export function getRequiredPermissions(manifest: ExtensionManifest): PermissionItem[] {
  const items: PermissionItem[] = [];
  const perms = manifest.permissions;

  if (perms.network) {
    for (const domain of perms.network) {
      items.push({ type: "network", value: domain, description: PERMISSION_DESCRIPTIONS.network!(domain) });
    }
  }
  if (perms.filesystem) {
    for (const path of perms.filesystem) {
      items.push({ type: "filesystem", value: path, description: PERMISSION_DESCRIPTIONS.filesystem!(path) });
    }
  }
  if (perms.shell) {
    items.push({ type: "shell", value: true, description: PERMISSION_DESCRIPTIONS.shell!(true) });
  }
  if (perms.env) {
    for (const varName of perms.env) {
      items.push({ type: "env", value: varName, description: PERMISSION_DESCRIPTIONS.env!(varName) });
    }
  }
  if (perms.storage) {
    items.push({ type: "storage", value: true, description: PERMISSION_DESCRIPTIONS.storage!(true) });
  }

  return items;
}

// ── Permission Diff ─────────────────────────────────────────────────

export function diffPermissions(
  requested: ExtensionPermissions,
  granted: ExtensionPermissions,
): ExtensionPermissions {
  const diff: ExtensionPermissions = { grantedAt: {} };

  if (requested.network) {
    const ungrantedDomains = requested.network.filter((d) => !granted.network?.includes(d));
    if (ungrantedDomains.length > 0) diff.network = ungrantedDomains;
  }

  if (requested.filesystem) {
    const ungrantedPaths = requested.filesystem.filter((p) => !granted.filesystem?.includes(p));
    if (ungrantedPaths.length > 0) diff.filesystem = ungrantedPaths;
  }

  if (requested.shell && !granted.shell) {
    diff.shell = true;
  }

  if (requested.env) {
    const ungrantedVars = requested.env.filter((v) => !granted.env?.includes(v));
    if (ungrantedVars.length > 0) diff.env = ungrantedVars;
  }

  if (requested.storage && !granted.storage) {
    diff.storage = true;
  }

  return diff;
}

// ── Sensitive Operations ────────────────────────────────────────────

export function isSensitiveOperation(_type: "shell" | "filesystem"): boolean {
  return true; // shell and filesystem are always sensitive
}

function alwaysAllowKey(extensionId: string, operationType: string): string {
  return `ext:${extensionId}:always_allow:${operationType}`;
}

export async function checkSensitiveConfirmation(
  extensionId: string,
  operationType: "shell" | "filesystem",
): Promise<"allowed" | "needs_confirmation"> {
  const value = await getSetting(alwaysAllowKey(extensionId, operationType));
  return value === true ? "allowed" : "needs_confirmation";
}

export async function setSensitiveAlwaysAllow(
  extensionId: string,
  operationType: "shell" | "filesystem",
  allowed: boolean,
): Promise<void> {
  await upsertSetting(alwaysAllowKey(extensionId, operationType), allowed);
}
