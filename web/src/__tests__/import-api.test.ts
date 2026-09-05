import { afterEach, expect, mock, test } from "bun:test";
import { importCommit, removeImportedSkill } from "../lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("skill import preserves the immutable build review location", async () => {
  const results = [{ kind: "skill", requested: "example", extId: "installation", operationId: "build", openUrl: "/extensions/author/installation", status: "ok" }];
  globalThis.fetch = mock(async () => Response.json({ results })) as unknown as typeof fetch;
  expect(await importCommit({ sessionId: "upload", projectId: "project", commands: [], skills: ["example"] })).toEqual({ results });
});

test("removing a staged skill uses lifecycle uninstall, not legacy projection deletion", async () => {
  const request = mock(async () => Response.json({ ok: true }));
  globalThis.fetch = request as unknown as typeof fetch;
  await removeImportedSkill("installation");
  expect(request).toHaveBeenCalledWith("/api/extensions/control", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "extensions_release", input: { action: "uninstall", installationId: "installation" } }),
  });
});

test("lifecycle removal errors remain visible to the importer", async () => {
  globalThis.fetch = mock(async () => Response.json({ error: "Not authorized" }, { status: 403 })) as unknown as typeof fetch;
  await expect(removeImportedSkill("installation")).rejects.toThrow("Not authorized");
});
