/**
 * Bootstraps internal-auth credentials for bundled extensions at server
 * startup. Called from `ensureInitialized()` BEFORE the extension registry
 * loads from DB, so by the time an extension subprocess is spawned, its
 * injected env is already in place.
 *
 * Security contract:
 *   - Keys live only in the registry's in-process map (never in
 *     process.env, never in the DB, never logged in raw form).
 *   - The allowlist is hard-coded in this file — extensions can NOT
 *     self-authorize via their own manifest.
 *   - Each bundled extension gets a fresh key on every server start.
 *     Old keys die with the process; a leaked key survives at most until
 *     the next restart.
 *   - EZCORP_BASE_URL is set to `http://127.0.0.1:<port>` (loopback IP,
 *     not `localhost`) to avoid DNS resolution pitfalls in containers
 *     and to make the loopback contract explicit: the subprocess MUST
 *     connect via the loopback interface for its injected key to
 *     verify.
 */

import { ExtensionRegistry } from "$server/extensions/registry";
import {
  provisionInternalKey,
  revokeInternalKey,
} from "$lib/server/security/internal-auth";
import { ensureSystemUser } from "$lib/server/security/system-user";
import type { ApiKeyScope } from "$lib/server/security/api-keys";

interface BundledCredSpec {
  extensionName: string;
  scopes: readonly ApiKeyScope[];
}

/** Hard-coded allowlist. Anything not listed here receives no internal
 *  credentials and must use normal user-issued API keys if it wants to
 *  call back into EZCorp. Keep this list as small as possible. */
const BUNDLED_CRED_SPECS: readonly BundledCredSpec[] = [
  // ai-kit needs read + chat to drive conversations, plus extensions to
  // enumerate and gate its own tool surface. It does NOT get admin —
  // provisionInternalKey would throw if we tried.
  { extensionName: "ai-kit", scopes: ["read", "chat", "extensions"] as const },
];

/** Resolve the URL the subprocess should call to reach this server.
 *  Uses the loopback IP (not `localhost`) to avoid the DNS mismatch
 *  class of bugs and to make the loopback-only security property
 *  unambiguous on the wire. */
export function resolveInternalBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env["EZCORP_BASE_URL"];
  if (explicit) return explicit;
  const raw = env["EZCORP_PORT"];
  // Strict port parse: reject anything that isn't a decimal-integer
  // string in the valid range. Number("abc") is NaN (OK), but
  // Number(" 5173") is 5173 — so we validate the string shape first.
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const port = Number(raw);
    if (port > 0 && port <= 65535) return `http://127.0.0.1:${port}`;
  }
  return "http://127.0.0.1:3000";
}

/** Provision keys for every bundled extension on the allowlist and
 *  register them with the extension registry so they're injected into
 *  the corresponding subprocess at spawn time.
 *
 *  Idempotent across dev-mode double module evaluation: each call
 *  re-provisions fresh keys, overwriting any prior state. Any previously
 *  issued keys become invalid at that moment — the registry's `setInjectedEnv`
 *  uses a defensive copy and the verifier rejects any key not in the
 *  current in-memory store.
 *
 *  Async because we seed the system-user row on first boot (one DB read
 *  + optional insert per allowlisted extension).
 */
export async function bootstrapBundledCredentials(
  registry: ExtensionRegistry = ExtensionRegistry.getInstance(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const baseUrl = resolveInternalBaseUrl(env);
  for (const spec of BUNDLED_CRED_SPECS) {
    if (env[`EZCORP_DISABLE_${spec.extensionName.toUpperCase().replace(/-/g, "_")}`] === "1") {
      // Operator opted the extension out entirely — don't mint credentials.
      revokeInternalKey(spec.extensionName);
      registry.clearInjectedEnv(spec.extensionName);
      continue;
    }
    const userId = await ensureSystemUser(spec.extensionName);
    const { raw } = provisionInternalKey(spec.extensionName, spec.scopes, userId);
    registry.setInjectedEnv(spec.extensionName, {
      EZCORP_API_KEY: raw,
      EZCORP_BASE_URL: baseUrl,
    });
  }
}

/** Revoke credentials for every bundled extension. Intended for shutdown
 *  or when an operator explicitly tears down the stack in tests. */
export function teardownBundledCredentials(
  registry: ExtensionRegistry = ExtensionRegistry.getInstance(),
): void {
  for (const spec of BUNDLED_CRED_SPECS) {
    revokeInternalKey(spec.extensionName);
    registry.clearInjectedEnv(spec.extensionName);
  }
}

/** Exported for tests that want to assert the allowlist shape. */
export function listBundledCredSpecs(): readonly BundledCredSpec[] {
  return BUNDLED_CRED_SPECS;
}
