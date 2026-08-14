/**
 * One stable, comparable id for the principal behind a request.
 *
 * Two gates need to ask "is the principal answering now the same one that
 * asked earlier?" across a boundary where no `locals` survives — a permission
 * gate parked in memory by a run that outlives its request. Comparing
 * `user.id` is not enough: a user may hold several API keys, and a leaked
 * narrow key would then inherit every consent its owner's browser session
 * earned. Comparing `authMethod` alone is not enough either: every key that
 * ever authenticated would look identical.
 *
 * So the id names BOTH axes — the auth METHOD and, for key principals, WHICH
 * key. The method prefix is what keeps the id-spaces disjoint: a session id
 * can never collide with a key id even if a key were ever named after a user.
 */

import type { AuthMethod } from "./middleware";

/** Structural slice of `App.Locals` this module reads. Declared locally for
 *  the same reason `AuthLocals` is in `./middleware` — the backend build has
 *  no SvelteKit `App` namespace in scope. */
export interface PrincipalLocals {
  user?: { id: string };
  authMethod?: AuthMethod;
  apiKeyId?: string;
}

/**
 * Opaque, comparable id for the principal, or `undefined` when the request
 * carries no principal this function can name.
 *
 * Shapes: `session:<userId>`, `api-key:<keyId>`, `internal:<keyId>`.
 *
 * `undefined` is returned rather than a partial id whenever an input the
 * shape needs is missing (no user; a key principal with no key id). That
 * matters because every consumer treats `undefined` as "cannot be shown to
 * match", i.e. the DENY side — a partial id would instead be a value that
 * two different principals could both produce.
 *
 * NOT a security decision by itself. It answers "who is this", never "may
 * they"; the callers own the second question.
 */
export function principalId(locals: PrincipalLocals): string | undefined {
  const method = locals.authMethod;
  if (method === undefined) return undefined;
  if (method === "session") {
    const userId = locals.user?.id;
    return userId === undefined ? undefined : `session:${userId}`;
  }
  const keyId = locals.apiKeyId;
  return keyId === undefined || keyId === "" ? undefined : `${method}:${keyId}`;
}
