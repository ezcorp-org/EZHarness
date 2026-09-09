import { json } from "@sveltejs/kit";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { requireSessionAuth } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { getProject } from "$server/db/queries/projects";
import { getExtensionProjectBinding } from "$server/extensions/project-binding";
import { readProjectGit } from "$server/extensions/project-git-broker";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return json({ message: "Not found" }, { status: 404 });
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;
  const body = await request.json();
  if (!body || typeof body.installationId !== "string") return json({ message: "Provide installationId" }, { status: 400 });
  const binding = await getExtensionProjectBinding(body.installationId);
  if (!binding || binding.ownerId !== user.id) return json({ message: "Binding not found" }, { status: 404 });
  const project = await getProject(binding.projectId);
  const origin = project?.path ? await readProjectGit(project.path, "origin") : null;
  if (typeof origin !== "string") return json({ message: "GitHub project required" }, { status: 400 });
  const snapshot = { head: "a".repeat(40), base: "b".repeat(40), nodeId: "controlled-browser-fixture", state: "OPEN", mergeable: "MERGEABLE", draft: true, files: ["docs/controlled-fixture.md"] };
  const id = crypto.randomUUID();
  const proposal = { id, installationId: body.installationId, ownerId: user.id, projectId: binding.projectId, bindingId: binding.id, number: 42, repository: origin.slice("https://github.com/".length), merge: false, runId: "controlled-browser-fixture", snapshot: { ...snapshot, digest: await sha256(canonicalJson(snapshot)) }, createdAt: Date.now() };
  await getDb().execute(sql`INSERT INTO extension_project_decisions(id, installation_id, state, payload) VALUES(${id}, ${body.installationId}, 'proposed', ${JSON.stringify(proposal)})`);
  return json({ id, controlledFixture: true, reviewUrl: `/extensions/project-proposals/${id}` }, { status: 201 });
};
