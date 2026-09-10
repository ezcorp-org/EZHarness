import { randomUUID } from "node:crypto";
import { createExtension } from "$server/db/queries/extensions";

/** Inert picker records, called only by the authenticated test seed route. */
export async function seedAgentExtensions(userId: string): Promise<Array<{ id: string; name: string }>> {
  const seeded: Array<{ id: string; name: string }> = [];
  for (const label of ["alpha", "beta", "gamma"]) {
    const id = randomUUID();
    const name = `chip-${label}-${id}`;
    await createExtension({
      id, name, version: "1.0.0", enabled: false, source: "local", creatorUserId: userId,
      manifest: { schemaVersion: 2, name, version: "1.0.0", description: "Inactive picker fixture", author: { name: "E2E" }, tools: [], permissions: {} },
      grantedPermissions: { grantedAt: {} },
    });
    seeded.push({ id, name });
  }
  return seeded;
}
