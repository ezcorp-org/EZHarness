import { expect, test } from "bun:test";
import { parseExtensionSourceInput } from "../source-input";

test("source input preserves supported identities and optional explicit adoption coordinates", () => {
  for (const input of [{ kind: "github", repository: "owner/repo", ref: "main", directory: "extension", projectId: "project", targetInstallationId: "existing-id" }, { kind: "marketplace", versionId: "version" }, { kind: "bundled", name: "ask-user" }, { kind: "local", path: "/project/source" }] as const) expect(parseExtensionSourceInput(input)).toEqual(input);
});

test("unknown source fields cannot persist credentials or impersonate a principal", () => {
  for (const field of ["token", "headers", "principal", "actor", "source", "__proto__"]) {
    const input = JSON.parse(`{"kind":"github","repository":"owner/repo","${field}":"secret"}`);
    expect(() => parseExtensionSourceInput(input)).toThrow("Unknown source fields");
  }
});

test("source input rejects malformed identities and unbounded or mistyped options", () => {
  for (const input of [null, [], "github", {}, { kind: "git", repository: "owner/repo" }, { kind: "github" }, { kind: "github", repository: "" }, { kind: "github", repository: 4 }, { kind: "github", repository: "owner/repo", directory: true }, { kind: "github", repository: "owner/repo", ref: "a".repeat(4097) }, { kind: "github", repository: "owner/repo", targetInstallationId: "../foreign" }, { kind: "github", repository: "owner/repo", targetInstallationId: "" }]) expect(() => parseExtensionSourceInput(input)).toThrow();
});
