/**
 * The chat send body's `permissionMode` is a per-TURN override that wins over
 * the project's stored mode (`setup-tools.ts` resolves
 * `options.permissionMode ?? busOverrideMode ?? getPermissionMode(projectId)`).
 * It arrived with no authorization check at all, on either intake path — so a
 * key holding nothing but `chat` could send `permissionMode: "yolo"` and
 * auto-approve `shell` / `edit_file` / `write` for the whole turn, on a
 * project whose owner had deliberately set `ask`.
 *
 * This is the gate. It is a CEILING, not a veto: the override may still
 * narrow (that is a caller volunteering to be asked more often, which needs
 * no authority), and it may still restate the mode already in force. Only a
 * WIDENING by a non-session principal is refused.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not touch `DEFAULT_PERMISSION_MODE`. That default is `yolo`
 *     and is a locked product decision (see
 *     `docs/features/platform/rbac-and-permission-modes.md`); a project that
 *     never configured a mode therefore has a `yolo` ceiling and any override
 *     passes. That is not a hole — the turn would have run at `yolo` with no
 *     override at all, so nothing here can widen anything. The check bites
 *     exactly the projects that tightened, which is exactly the population
 *     that expressed an intent to be protected.
 *   - It does not read `busOverrideMode`. The ceiling is the project's
 *     PERSISTED intent; a live mid-run mode switch is itself a
 *     `chat`-authorized action and is not evidence of what the owner wants a
 *     key to be able to do.
 */

import { isInteractiveSession } from "./middleware";
import type { AuthMethod } from "./middleware";
import {
  getPermissionMode,
  widensPermissionMode,
  type PermissionMode,
} from "../runtime/tools/permissions";

/** Body field this gate governs. Named in the refusal so a caller is told
 *  which of its inputs was rejected, not merely that something was. */
export const PERMISSION_MODE_FIELD = "permissionMode";

export interface PermissionModeCeilingDenial {
  /** The mode the request asked for. */
  requested: PermissionMode;
  /** The project's effective mode — the most the request may ask for. */
  ceiling: PermissionMode;
  /** Body/form field that carried `requested`. */
  field: typeof PERMISSION_MODE_FIELD;
  /** Ready-to-serve message; the route decides the status code. */
  error: string;
}

/**
 * Refuse a per-turn `permissionMode` that widens the project's stored gate,
 * unless the principal is an interactive human session.
 *
 * Returns `null` to allow, or the denial to refuse.
 *
 * The session carve-out is `isInteractiveSession`, the same allowlist
 * `requireSessionAuth` uses — so `api-key`, `internal`, and any auth method
 * added later are all confined until someone deliberately decides otherwise.
 * A human at a browser needs no ceiling: they can already PUT the project
 * mode itself, so refusing the per-turn override would protect nothing and
 * would break the mode picker in the chat header.
 */
export async function checkPermissionModeCeiling(
  locals: { authMethod?: AuthMethod },
  projectId: string,
  requested: PermissionMode | undefined,
): Promise<PermissionModeCeilingDenial | null> {
  if (requested === undefined) return null;
  if (isInteractiveSession(locals)) return null;

  const ceiling = await getPermissionMode(projectId);
  if (!widensPermissionMode(requested, ceiling)) return null;

  return {
    requested,
    ceiling,
    field: PERMISSION_MODE_FIELD,
    error:
      `${PERMISSION_MODE_FIELD} "${requested}" widens this project's tool ` +
      `permission mode ("${ceiling}"). An API key may narrow the mode for a ` +
      `turn, never widen it — change the project's mode instead.`,
  };
}
