import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import {
  decrypt,
  decryptWithAad,
  encryptWithAad,
} from "../providers/encryption";
import {
  deleteSecret as deleteSecretRow,
  getSecretRow,
  insertOrReplaceSecret,
  listSecretMeta as listSecretMetaRow,
  touchLastUsed,
} from "../db/queries/extension-secrets";
import type { SecretMeta, SecretScope } from "../db/queries/extension-secrets";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";

/**
 * Host-side extension-secrets store: the ONLY place crypto, audit, and the
 * lastUsedAt debounce wrap the raw `extension_secrets` CRUD
 * (src/db/queries/extension-secrets.ts).
 *
 * SECURITY — HOST ONLY. `getSecret()` returns the decrypted plaintext. It
 * MUST NEVER be wired to the extension sandbox / reverse-RPC surface: an
 * extension that could call it would defeat the entire point of an
 * AEAD-bound, scope-isolated credential store. Only trusted host code
 * (integration daemons, route handlers running in-process) may call it.
 *
 * Each ciphertext is AES-256-GCM with `${extensionId}:${projectId}` bound as
 * AAD, so a row copied into another scope fails to decrypt — the AAD is
 * reconstructed here at read time, never stored.
 */

/** Don't re-touch lastUsedAt / re-audit SECRET_USED more than once per this
 *  window — high-frequency reads (a polling daemon) would otherwise flood the
 *  audit log and hammer the row. */
const TOUCH_DEBOUNCE_MS = 60_000;

/** SELECT of every github-projects PAT blob in the broadly-readable settings
 *  table. Hoisted to module level (not inlined) to dodge bun's
 *  coverage-attribution drift on multi-line template literals in fn bodies. */
const SELECT_GH_PAT_KEYS = sql`SELECT key, value FROM settings WHERE key LIKE 'githubProjects:%:apiToken'`;

const GH_PAT_PREFIX = "githubProjects:";
const GH_PAT_SUFFIX = ":apiToken";
/** The bundled extension's stable manifest slug — the FK value stored in
 *  `extension_secrets.extension_id` for migrated github-projects tokens. */
const GH_EXTENSION_ID = "github-projects";

type SecretOpts = { userId?: string | null };

/** Reconstructs the AAD a secret's ciphertext is bound to. Scope-binding key:
 *  a ciphertext encrypted for `(extensionId, projectId)` cannot be decrypted
 *  under any other scope. `userId` is intentionally NOT part of the AAD — the
 *  scope tuple's uniqueness (and FK cascade) already isolates per-user rows;
 *  the AAD binds the security-relevant extension+project boundary. */
function aadFor(extensionId: string, projectId: string | null): string {
  return `${extensionId}:${projectId ?? ""}`;
}

function scopeFor(extensionId: string, projectId: string | null, name: string, opts?: SecretOpts): SecretScope {
  return { extensionId, projectId, userId: opts?.userId ?? null, name };
}

/**
 * Encrypt + store (or rotate) a secret, then audit SECRET_SET. The plaintext
 * `value` is NEVER logged — the audit metadata carries only `{projectId, name}`.
 */
export async function setSecret(
  extensionId: string,
  projectId: string | null,
  name: string,
  value: string,
  opts?: SecretOpts,
): Promise<void> {
  const ciphertext = encryptWithAad(value, aadFor(extensionId, projectId));
  await insertOrReplaceSecret(scopeFor(extensionId, projectId, name, opts), ciphertext);
  await insertAuditEntry(opts?.userId ?? null, EXT_AUDIT_ACTIONS.SECRET_SET, extensionId, {
    projectId,
    name,
  });
}

/**
 * HOST-ONLY plaintext read. Returns `null` when the secret is missing or its
 * ciphertext fails to decrypt under the reconstructed scope AAD (tampered row,
 * wrong scope, or key rotation). On a successful read, debounces a
 * `lastUsedAt` touch + SECRET_USED audit (at most once per
 * {@link TOUCH_DEBOUNCE_MS}).
 *
 * DO NOT expose this to the extension sandbox.
 */
export async function getSecret(
  extensionId: string,
  projectId: string | null,
  name: string,
  opts?: SecretOpts,
): Promise<string | null> {
  const scope = scopeFor(extensionId, projectId, name, opts);
  const row = await getSecretRow(scope);
  if (!row) return null;

  let plaintext: string;
  try {
    plaintext = decryptWithAad(row.ciphertext, aadFor(extensionId, projectId));
  } catch {
    return null;
  }

  const last = row.lastUsedAt ? row.lastUsedAt.getTime() : 0;
  if (Date.now() - last >= TOUCH_DEBOUNCE_MS) {
    await touchLastUsed(scope);
    await insertAuditEntry(opts?.userId ?? null, EXT_AUDIT_ACTIONS.SECRET_USED, extensionId, {
      projectId,
      name,
    });
  }
  return plaintext;
}

/** True iff a secret row exists at the scope AND decrypts cleanly. */
export async function hasSecret(
  extensionId: string,
  projectId: string | null,
  name: string,
  opts?: SecretOpts,
): Promise<boolean> {
  const row = await getSecretRow(scopeFor(extensionId, projectId, name, opts));
  if (!row) return false;
  try {
    decryptWithAad(row.ciphertext, aadFor(extensionId, projectId));
    return true;
  } catch {
    return false;
  }
}

/** Deletes a secret. On a real deletion, audits SECRET_DELETED. */
export async function deleteSecret(
  extensionId: string,
  projectId: string | null,
  name: string,
  opts?: SecretOpts,
): Promise<boolean> {
  const deleted = await deleteSecretRow(scopeFor(extensionId, projectId, name, opts));
  if (deleted) {
    await insertAuditEntry(opts?.userId ?? null, EXT_AUDIT_ACTIONS.SECRET_DELETED, extensionId, {
      projectId,
      name,
    });
  }
  return deleted;
}

/** Metadata listing (no ciphertext) — passthrough to the query layer. */
export async function listSecretMeta(
  extensionId: string,
  opts?: { projectId?: string | null },
): Promise<SecretMeta[]> {
  return listSecretMetaRow({ extensionId, projectId: opts?.projectId });
}

/** Parses the `<projectId>` segment out of a `githubProjects:<pid>:apiToken`
 *  settings key. A UUID projectId contains no `:`, so the slice between the
 *  fixed prefix and suffix is exact. */
function parseGhProjectId(key: string): string {
  return key.slice(GH_PAT_PREFIX.length, key.length - GH_PAT_SUFFIX.length);
}

/**
 * One-shot, idempotent backfill of the legacy github-projects PAT blobs (which
 * lived `encrypt()`'d under `githubProjects:<pid>:apiToken` in the broadly
 * readable `settings` table) into the scope-isolated, AAD-bound
 * `extension_secrets` store.
 *
 * For each matching settings row:
 *   - decrypt(value) → on success, re-encrypt with the scope AAD and INSERT …
 *     ON CONFLICT DO NOTHING (covers the COALESCE-unique index without naming
 *     a target). Counts toward `migrated`.
 *   - decrypt failure (already-unusable blob) → insert nothing.
 *   - EITHER WAY, DELETE the settings key (counts toward `cleared`) — the
 *     credential must leave the broadly-readable table regardless.
 *
 * `executor` defaults to `getDb()`; the migrate pass passes its own `db`
 * handle because getDb() is not guaranteed wired during migration. All SQL
 * goes through the passed executor.
 */
export async function backfillGithubProjectsApiTokens(
  // Accepts the migrate `db` handle OR getDb(); both expose `.execute(sql\`…\`)`.
  // Typed `any` to match migrate.ts's own `db: any` handle (the github-projects
  // backfill / queries do the same) rather than fight drizzle's generic shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any = getDb(),
): Promise<{ migrated: number; cleared: number }> {
  const selected = (await executor.execute(SELECT_GH_PAT_KEYS)) as { rows?: Array<{ key: string; value: unknown }> };
  const rows = selected.rows ?? [];

  let migrated = 0;
  let cleared = 0;
  for (const row of rows) {
    const key = row.key;
    const stored = typeof row.value === "string" ? row.value : String(row.value);
    const projectId = parseGhProjectId(key);

    let plaintext: string | null = null;
    try {
      plaintext = decrypt(stored);
    } catch {
      plaintext = null;
    }

    if (plaintext !== null) {
      const ciphertext = encryptWithAad(plaintext, aadFor(GH_EXTENSION_ID, projectId));
      await executor.execute(
        sql`INSERT INTO extension_secrets (id, extension_id, project_id, user_id, name, ciphertext) VALUES (${crypto.randomUUID()}, ${GH_EXTENSION_ID}, ${projectId}, ${null}, ${"apiToken"}, ${ciphertext}) ON CONFLICT DO NOTHING`,
      );
      migrated += 1;
    }

    await executor.execute(sql`DELETE FROM settings WHERE key = ${key}`);
    cleared += 1;
  }

  return { migrated, cleared };
}
