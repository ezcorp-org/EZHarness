import { json } from "@sveltejs/kit";

export function legacyExtensionEndpoint(): Response {
  return json({ code: "extension_v4_required", message: "Use a versioned workspace, isolated build, and human-approved release", importUrl: "/api/extensions/import-source", controlUrl: "/api/extensions/control", openUrl: "/extensions/author" }, { status: 410 });
}
