import { randomUUID } from "node:crypto";
import { createExtension } from "$server/db/queries/extensions";

/** Inert picker records, called only by the authenticated test seed route. */
export async function seedAgentExtensions(userId: string): Promise<Array<{ id: string; name: string }>> {
  const seeded: Array<{ id: string; name: string }> = [];
  for (const label of ["alpha", "beta", "gamma"]) {
    seeded.push(await seedInactiveExtension(userId, `chip-${label}`));
  }
  return seeded;
}

/** An inert owned record for fixtures that need a real extension foreign key. */
export async function seedInactiveExtension(userId: string, prefix: string): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = `${prefix}-${id}`;
  await createExtension({
    id, name, version: "1.0.0", enabled: false, source: "local", creatorUserId: userId,
    manifest: { schemaVersion: 2, name, version: "1.0.0", description: "Inactive test fixture", author: { name: "E2E" }, tools: [], permissions: {} },
    grantedPermissions: { grantedAt: {} },
  });
  return { id, name };
}
