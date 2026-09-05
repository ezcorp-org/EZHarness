import { json } from "@sveltejs/kit";

export function legacyExtensionEndpoint(installationId?: string): Response {
  return json({ code: "extension_v4_required", message: "Use a versioned workspace, isolated build, and human-approved release", importUrl: "/api/extensions/import-source", controlUrl: "/api/extensions/control", openUrl: "/extensions/author", ...(installationId ? { reviewUrl: `/extensions/author?installation=${encodeURIComponent(installationId)}` } : {}) }, { status: 410 });
}
