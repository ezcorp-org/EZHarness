/**
 * Report the boot-time bundled build progress so a real-server test lane can
 * wait for a quiet isolated runner before any spec builds
 * (web/e2e/fixtures/bundled-bootstrap.ts). Read-only, administrator-only, and
 * fail-closed to 404 outside an explicitly enabled test server.
 */
import { json } from "@sveltejs/kit";
import { checkRole } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { bundledBootstrapStatus } from "$server/extensions/bundled-bootstrap";
import { resolveBundledExtensions } from "$server/extensions/bundled";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const administrator = checkRole(locals, "admin");
  if (administrator instanceof Response) return administrator;
  return json(await bundledBootstrapStatus(resolveBundledExtensions()));
};
