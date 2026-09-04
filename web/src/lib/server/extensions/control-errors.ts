import { json } from "@sveltejs/kit";

export function extensionControlError(error: unknown): Response {
  if (error instanceof Response) return error;
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof SyntaxError ? "invalid_json" : "extension_failed";
  const status = code === "not_found" ? 404 : /forbidden|denied|human.*required|unauthorized/.test(code) ? 403 : /conflict|stale|revision|already|lease/.test(code) ? 409 : /invalid|unknown|limit/.test(code) ? 400 : /runner_unavailable|runner_unconfigured|broker_unavailable/.test(code) ? 503 : 500;
  const message = code !== "extension_failed" && error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "Extension operation failed.";
  return json({ code, message }, { status });
}
